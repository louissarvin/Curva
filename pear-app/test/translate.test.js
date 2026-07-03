// Phase 3.5 brittle test: QVAC translator orchestrator.
//
// The real Bergamot binaries are ~17MB and require @qvac/sdk /
// @qvac/translation-nmtcpp at runtime, neither of which are lockfile deps here.
// So we exercise the module via its injectable seams:
//   - engineFactory: returns a fake Engine that echoes translations
//   - fetchImpl: intercepts model downloads
//   - fsImpl:    optional shim (we use real bare-fs into a tmp dir instead)
//
// All external side effects land in a tmp dir cleaned up in each test.

const test = require('brittle')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')

const {
  createTranslator,
  DEFAULT_PAIRS,
  _internal
} = require('../bare/translate.js')

// -- helpers ---------------------------------------------------------------

let counter = 0

function makeTmpDir() {
  const dir = path.join(os.tmpdir(), `curva-translate-${process.pid}-${Date.now()}-${counter++}`)
  fs.mkdirSync(dir, { recursive: true })
  return {
    dir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
    }
  }
}

// Fake QVAC engine that just echoes a fixed prefix + text so tests can verify
// that translate() actually goes through the engine seam.
function makeFakeEngine({ throwOnLoad = null, throwOnTranslate = null } = {}) {
  const loaded = []
  return {
    loaded,
    async loadModel(opts) {
      if (throwOnLoad) throw new Error(throwOnLoad)
      loaded.push(opts)
    },
    async translate({ modelId, text, sourceLang, targetLang }) {
      if (throwOnTranslate) throw new Error(throwOnTranslate)
      return `[${sourceLang}->${targetLang}] ${text}`
    },
    async close() { loaded.length = 0 }
  }
}

// Fake backend client. Catalog + downloadUrl are mutable per test.
function makeFakeBackend({ models = [], failCatalog = false } = {}) {
  return {
    async getQvacModels() {
      if (failCatalog) return { ok: false, error: { code: 'X' } }
      return { ok: true, data: { models } }
    },
    getQvacModelDownloadUrl(id) {
      return 'https://fake/qvac/models/' + id + '/download'
    }
  }
}

// Fake fetch that returns a body from a lookup table.
function makeFakeFetch(bodyByUrl, { failUrls = new Set() } = {}) {
  return async function fakeFetch(url) {
    if (failUrls.has(url)) return { ok: false, status: 500 }
    const body = bodyByUrl.get(url)
    if (!body) return { ok: false, status: 404 }
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          if (name.toLowerCase() === 'content-length') return String(body.byteLength)
          return null
        }
      },
      async arrayBuffer() { return body.buffer }
    }
  }
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

// -- SHA-256 -----------------------------------------------------------------

test('_internal.sha256Sync produces correct sha256 for known vectors', (t) => {
  const empty = _internal.sha256Sync(new Uint8Array(0))
  t.is(
    empty,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'empty string sha256'
  )
  const abc = _internal.sha256Sync(new TextEncoder().encode('abc'))
  t.is(
    abc,
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'abc sha256'
  )
})

test('_internal.sha256Sync matches node crypto for random buffers', (t) => {
  for (const size of [1, 55, 56, 63, 64, 65, 100, 1000]) {
    const bytes = crypto.randomBytes(size)
    const ours = _internal.sha256Sync(new Uint8Array(bytes))
    const theirs = crypto.createHash('sha256').update(bytes).digest('hex')
    t.is(ours, theirs, `size ${size}`)
  }
})

// -- basic surface -----------------------------------------------------------

test('createTranslator returns expected surface', async (t) => {
  const tmp = makeTmpDir()
  const engine = makeFakeEngine()
  const fake = makeFakeBackend({ models: [] })
  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: fake,
    engineFactory: () => engine,
    pairs: [], // no pairs -> init should fail (no models loaded); still returns instance
    timeoutMs: 500
  })

  t.is(typeof tr.translate, 'function')
  t.is(typeof tr.isReady, 'function')
  t.is(typeof tr.listAvailableModels, 'function')
  t.is(typeof tr.status, 'function')
  t.is(typeof tr.close, 'function')

  await tr.close()
  tmp.cleanup()
})

// -- happy path --------------------------------------------------------------

test('creates model dir + downloads missing models via backend', async (t) => {
  const tmp = makeTmpDir()

  const modelBytes = crypto.randomBytes(64)
  const digest = sha256Hex(modelBytes)
  const models = [{
    id: 'bergamot-itid',
    contentDigest: 'sha256:' + digest,
    size: modelBytes.byteLength
  }]
  const fake = makeFakeBackend({ models })
  const bodyByUrl = new Map([
    ['https://fake/qvac/models/bergamot-itid/download', modelBytes]
  ])
  const engine = makeFakeEngine()

  const progress = []
  const errors = []
  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: fake,
    engineFactory: () => engine,
    fetchImpl: makeFakeFetch(bodyByUrl),
    pairs: [{ from: 'it', to: 'id', modelId: 'bergamot-itid' }],
    timeoutMs: 5000,
    onProgress: (ev) => progress.push(ev),
    onError: (ev) => errors.push(ev)
  })

  t.is(errors.length, 0, 'no errors emitted')
  const st = tr.status()
  t.ok(st.ready, 'translator is ready')
  t.is(st.loaded.length, 1)
  t.is(st.loaded[0].from, 'it')
  t.is(st.loaded[0].to, 'id')

  // Model file was written to disk with the exact bytes.
  const onDisk = fs.readFileSync(path.join(tmp.dir, 'qvac-models', 'bergamot-itid'))
  t.is(onDisk.byteLength, modelBytes.byteLength)

  // Engine loadModel called exactly once for this pair.
  t.is(engine.loaded.length, 1)
  t.is(engine.loaded[0].sourceLang, 'it')
  t.is(engine.loaded[0].targetLang, 'id')

  // At least one progress event mentions ready phase.
  t.ok(progress.some((p) => p.phase === 'ready'), 'ready phase emitted')

  await tr.close()
  tmp.cleanup()
})

// -- translate() -------------------------------------------------------------

test('translate() routes through engine when pair is loaded', async (t) => {
  const tmp = makeTmpDir()
  const modelBytes = crypto.randomBytes(32)
  const digest = sha256Hex(modelBytes)
  const models = [{ id: 'm1', contentDigest: digest, size: modelBytes.length }]
  const fake = makeFakeBackend({ models })
  const bodyByUrl = new Map([
    ['https://fake/qvac/models/m1/download', modelBytes]
  ])
  const engine = makeFakeEngine()

  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: fake,
    engineFactory: () => engine,
    fetchImpl: makeFakeFetch(bodyByUrl),
    pairs: [{ from: 'it', to: 'id', modelId: 'm1' }],
    timeoutMs: 2000
  })

  const out = await tr.translate({ text: 'ciao amico', from: 'it', to: 'id' })
  t.is(out, '[it->id] ciao amico')
  t.ok(tr.isReady('it', 'id'), 'pair is ready')
  t.absent(tr.isReady('en', 'id'), 'unloaded pair is not ready')

  await tr.close()
  tmp.cleanup()
})

test('translate() returns text unchanged when from == to', async (t) => {
  const tmp = makeTmpDir()
  const modelBytes = crypto.randomBytes(16)
  const models = [{ id: 'm1', contentDigest: sha256Hex(modelBytes), size: modelBytes.length }]
  const bodyByUrl = new Map([['https://fake/qvac/models/m1/download', modelBytes]])
  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models }),
    engineFactory: () => makeFakeEngine(),
    fetchImpl: makeFakeFetch(bodyByUrl),
    pairs: [{ from: 'it', to: 'id', modelId: 'm1' }],
    timeoutMs: 2000
  })
  const same = await tr.translate({ text: 'test', from: 'it', to: 'it' })
  t.is(same, 'test')
  await tr.close()
  tmp.cleanup()
})

// Wave 6 T1: translate() routes via pivot when direct pair is missing.
test('translate() pivots via en when direct pair is missing', async (t) => {
  const tmp = makeTmpDir()
  const bytesA = crypto.randomBytes(16)
  const bytesB = crypto.randomBytes(16)
  const models = [
    { id: 'm-it-en', contentDigest: sha256Hex(bytesA), size: bytesA.length },
    { id: 'm-en-id', contentDigest: sha256Hex(bytesB), size: bytesB.length }
  ]
  const bodyByUrl = new Map([
    ['https://fake/qvac/models/m-it-en/download', bytesA],
    ['https://fake/qvac/models/m-en-id/download', bytesB]
  ])
  const engine = makeFakeEngine()
  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models }),
    engineFactory: () => engine,
    fetchImpl: makeFakeFetch(bodyByUrl),
    // NO direct it->id pair. Only it->en and en->id.
    pairs: [
      { from: 'it', to: 'en', modelId: 'm-it-en' },
      { from: 'en', to: 'id', modelId: 'm-en-id' }
    ],
    timeoutMs: 3000
  })

  const out = await tr.translate({ text: 'ciao', from: 'it', to: 'id' })
  // Fake engine echoes [src->dst] text on each leg. Second leg receives the
  // first leg's output as text.
  t.is(out, '[en->id] [it->en] ciao', 'pivoted through english')

  await tr.close()
  tmp.cleanup()
})

test('translatePivot() returns partial when second leg throws', async (t) => {
  const tmp = makeTmpDir()
  const bytesA = crypto.randomBytes(16)
  const bytesB = crypto.randomBytes(16)
  const models = [
    { id: 'm-it-en', contentDigest: sha256Hex(bytesA), size: bytesA.length },
    { id: 'm-en-id', contentDigest: sha256Hex(bytesB), size: bytesB.length }
  ]
  const bodyByUrl = new Map([
    ['https://fake/qvac/models/m-it-en/download', bytesA],
    ['https://fake/qvac/models/m-en-id/download', bytesB]
  ])
  // Engine that throws on the SECOND translate call.
  let callCount = 0
  const engine = {
    loaded: [],
    async loadModel(o) { this.loaded.push(o) },
    async translate({ text, sourceLang, targetLang }) {
      callCount++
      if (callCount === 2) throw new Error('second leg boom')
      return `[${sourceLang}->${targetLang}] ${text}`
    },
    async close() {}
  }
  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models }),
    engineFactory: () => engine,
    fetchImpl: makeFakeFetch(bodyByUrl),
    pairs: [
      { from: 'it', to: 'en', modelId: 'm-it-en' },
      { from: 'en', to: 'id', modelId: 'm-en-id' }
    ],
    timeoutMs: 3000
  })

  const out = await tr.translatePivot({ from: 'it', via: 'en', to: 'id', text: 'ciao' })
  // out is a String object with .partial flag when second leg fails.
  t.is(String(out), '[it->en] ciao', 'intermediate returned')
  t.ok(out.partial === true, 'partial flag set')

  await tr.close()
  tmp.cleanup()
})

test('translate() rejects when pair is not loaded', async (t) => {
  const tmp = makeTmpDir()
  const modelBytes = crypto.randomBytes(16)
  const models = [{ id: 'm1', contentDigest: sha256Hex(modelBytes), size: modelBytes.length }]
  const bodyByUrl = new Map([['https://fake/qvac/models/m1/download', modelBytes]])
  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models }),
    engineFactory: () => makeFakeEngine(),
    fetchImpl: makeFakeFetch(bodyByUrl),
    pairs: [{ from: 'it', to: 'id', modelId: 'm1' }],
    timeoutMs: 2000
  })
  await t.exception.all(() => tr.translate({ text: 'hi', from: 'zh', to: 'ja' }), 'unloaded pair rejected')
  await tr.close()
  tmp.cleanup()
})

test('translate() rejects on empty text / bad args', async (t) => {
  const tmp = makeTmpDir()
  const modelBytes = crypto.randomBytes(16)
  const models = [{ id: 'm1', contentDigest: sha256Hex(modelBytes), size: modelBytes.length }]
  const bodyByUrl = new Map([['https://fake/qvac/models/m1/download', modelBytes]])
  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models }),
    engineFactory: () => makeFakeEngine(),
    fetchImpl: makeFakeFetch(bodyByUrl),
    pairs: [{ from: 'it', to: 'id', modelId: 'm1' }],
    timeoutMs: 2000
  })
  await t.exception.all(() => tr.translate({ text: '', from: 'it', to: 'id' }), 'empty text rejected')
  await t.exception.all(() => tr.translate({ text: 'hi', from: 42, to: 'id' }), 'bad from type rejected')
  await tr.close()
  tmp.cleanup()
})

// -- integrity verification --------------------------------------------------

test('SHA-256 mismatch rejects the download and disables the pair', async (t) => {
  const tmp = makeTmpDir()
  const modelBytes = crypto.randomBytes(64)
  const wrongDigest = sha256Hex(crypto.randomBytes(64)) // different bytes
  const models = [{ id: 'bad-model', contentDigest: wrongDigest, size: modelBytes.length }]
  const bodyByUrl = new Map([['https://fake/qvac/models/bad-model/download', modelBytes]])
  const errors = []

  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models }),
    engineFactory: () => makeFakeEngine(),
    fetchImpl: makeFakeFetch(bodyByUrl),
    pairs: [{ from: 'it', to: 'id', modelId: 'bad-model' }],
    timeoutMs: 2000,
    onError: (e) => errors.push(e)
  })

  t.ok(errors.some((e) => e.code === 'DOWNLOAD_FAILED' || e.code === 'DIGEST_MISMATCH'), 'digest mismatch bubbled')
  const st = tr.status()
  t.absent(st.ready, 'translator not ready when digest fails')
  await tr.close()
  tmp.cleanup()
})

test('cached model with valid digest is not re-downloaded', async (t) => {
  const tmp = makeTmpDir()
  const modelBytes = crypto.randomBytes(64)
  const digest = sha256Hex(modelBytes)
  // Pre-place the file on disk.
  const modelDir = path.join(tmp.dir, 'qvac-models')
  fs.mkdirSync(modelDir, { recursive: true })
  fs.writeFileSync(path.join(modelDir, 'm1'), Buffer.from(modelBytes))

  const models = [{ id: 'm1', contentDigest: digest, size: modelBytes.length }]

  let fetchCount = 0
  const fetchImpl = async () => {
    fetchCount++
    return { ok: false, status: 999 } // if called, test fails
  }

  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models }),
    engineFactory: () => makeFakeEngine(),
    fetchImpl,
    pairs: [{ from: 'it', to: 'id', modelId: 'm1' }],
    timeoutMs: 2000
  })

  t.is(fetchCount, 0, 'fetch was never called (used cache)')
  t.ok(tr.status().ready, 'translator ready from cache')
  await tr.close()
  tmp.cleanup()
})

test('cached model with wrong digest triggers redownload', async (t) => {
  const tmp = makeTmpDir()
  const goodBytes = crypto.randomBytes(64)
  const goodDigest = sha256Hex(goodBytes)
  // Place BAD bytes on disk to simulate corrupted cache.
  const badBytes = crypto.randomBytes(64)
  const modelDir = path.join(tmp.dir, 'qvac-models')
  fs.mkdirSync(modelDir, { recursive: true })
  fs.writeFileSync(path.join(modelDir, 'm1'), Buffer.from(badBytes))

  const models = [{ id: 'm1', contentDigest: goodDigest, size: goodBytes.length }]
  const bodyByUrl = new Map([['https://fake/qvac/models/m1/download', goodBytes]])

  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models }),
    engineFactory: () => makeFakeEngine(),
    fetchImpl: makeFakeFetch(bodyByUrl),
    pairs: [{ from: 'it', to: 'id', modelId: 'm1' }],
    timeoutMs: 2000
  })

  t.ok(tr.status().ready, 'translator ready after redownload')
  // Verify the file on disk is now the good bytes.
  const onDisk = fs.readFileSync(path.join(modelDir, 'm1'))
  t.is(sha256Hex(new Uint8Array(onDisk)), goodDigest, 'redownloaded bytes match good digest')
  await tr.close()
  tmp.cleanup()
})

test('missing contentDigest (pending-upstream) accepts cache without hash', async (t) => {
  // Mirrors the F12 catalog state where digest hasn't been pinned yet.
  const tmp = makeTmpDir()
  const modelBytes = crypto.randomBytes(64)
  const modelDir = path.join(tmp.dir, 'qvac-models')
  fs.mkdirSync(modelDir, { recursive: true })
  fs.writeFileSync(path.join(modelDir, 'm1'), Buffer.from(modelBytes))

  const models = [{ id: 'm1', contentDigest: null, size: modelBytes.length, status: 'pending-upstream' }]

  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models }),
    engineFactory: () => makeFakeEngine(),
    fetchImpl: async () => { throw new Error('should not fetch') },
    pairs: [{ from: 'it', to: 'id', modelId: 'm1' }],
    timeoutMs: 2000
  })

  t.ok(tr.status().ready, 'translator ready without integrity check when no digest')
  await tr.close()
  tmp.cleanup()
})

// -- graceful degradation ----------------------------------------------------

test('missing engine disables translator gracefully', async (t) => {
  const tmp = makeTmpDir()
  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models: [] }),
    engineFactory: () => null,
    pairs: [{ from: 'it', to: 'id', modelId: 'm1' }],
    timeoutMs: 500
  })

  const st = tr.status()
  t.absent(st.ready, 'not ready')
  t.ok(st.disabled, 'disabled flag set')
  await t.exception.all(() => tr.translate({ text: 'hi', from: 'it', to: 'id' }), 'translate rejects when disabled')
  await tr.close()
  tmp.cleanup()
})

test('init timeout disables translator', async (t) => {
  const tmp = makeTmpDir()
  const errors = []
  // Engine factory hangs forever -> exceeds timeout.
  const slowFactory = () => new Promise(() => { /* never resolves */ })
  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models: [] }),
    engineFactory: slowFactory,
    pairs: [{ from: 'it', to: 'id', modelId: 'm1' }],
    timeoutMs: 200,
    onError: (e) => errors.push(e)
  })

  t.ok(errors.some((e) => e.code === 'INIT_TIMEOUT'), 'INIT_TIMEOUT error emitted')
  t.absent(tr.status().ready, 'translator not ready after timeout')
  await tr.close()
  tmp.cleanup()
})

test('engine loadModel throwing does not crash init; that pair just stays unloaded', async (t) => {
  const tmp = makeTmpDir()
  const modelBytes = crypto.randomBytes(16)
  const models = [{ id: 'm1', contentDigest: sha256Hex(modelBytes), size: modelBytes.length }]
  const bodyByUrl = new Map([['https://fake/qvac/models/m1/download', modelBytes]])
  const engine = makeFakeEngine({ throwOnLoad: 'engine boom' })
  const errors = []

  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models }),
    engineFactory: () => engine,
    fetchImpl: makeFakeFetch(bodyByUrl),
    pairs: [{ from: 'it', to: 'id', modelId: 'm1' }],
    timeoutMs: 2000,
    onError: (e) => errors.push(e)
  })

  t.ok(errors.some((e) => e.code === 'LOAD_FAILED'), 'LOAD_FAILED emitted')
  t.absent(tr.status().ready, 'no ready pair')
  await tr.close()
  tmp.cleanup()
})

test('backend catalog fetch failure still allows local-cache usage', async (t) => {
  const tmp = makeTmpDir()
  const modelBytes = crypto.randomBytes(64)
  const modelDir = path.join(tmp.dir, 'qvac-models')
  fs.mkdirSync(modelDir, { recursive: true })
  fs.writeFileSync(path.join(modelDir, 'm1'), Buffer.from(modelBytes))

  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ failCatalog: true }),
    engineFactory: () => makeFakeEngine(),
    fetchImpl: async () => { throw new Error('should not fetch') },
    pairs: [{ from: 'it', to: 'id', modelId: 'm1' }],
    timeoutMs: 2000
  })

  // Cache accepted since we had no digest to verify against.
  t.ok(tr.status().ready, 'ready via cache even with backend down')
  await tr.close()
  tmp.cleanup()
})

// -- default pairs sanity check ---------------------------------------------

test('DEFAULT_PAIRS covers the demo triangle (it, id, en) bidirectionally', (t) => {
  const pairs = new Set(DEFAULT_PAIRS.map((p) => p.from + '>' + p.to))
  t.ok(pairs.has('it>id'), 'it->id')
  t.ok(pairs.has('id>it'), 'id->it')
  t.ok(pairs.has('it>en'), 'it->en')
  t.ok(pairs.has('en>it'), 'en->it')
  t.ok(pairs.has('en>id'), 'en->id')
  t.ok(pairs.has('id>en'), 'id->en')
})

test('DEFAULT_PAIRS reference the EN-hub F12 bergamot model ids (Fix Wave C T3)', (t) => {
  // Legacy pseudo-entries (bergamot-itid/iten/enid) were removed from F12
  // because they pointed at github.com/browsermt/students/releases which hosts
  // no binaries. IT<->ID hops now pivot through EN via the SDK's native
  // modelConfig.pivotModel path (Fix Wave C T1).
  const ids = new Set(DEFAULT_PAIRS.map((p) => p.modelId))
  t.ok(ids.has('bergamot-it-en'), 'IT->EN direct model referenced')
  t.ok(ids.has('bergamot-en-it'), 'EN->IT direct model referenced')
  t.ok(ids.has('bergamot-en-id'), 'EN->ID direct model referenced')
  t.ok(ids.has('bergamot-id-en'), 'ID->EN direct model referenced')

  // Pivot pairs carry pivotModelId + via so wrapSdkEngine can wire
  // modelConfig.pivotModel at loadModel time.
  const pivotPairs = DEFAULT_PAIRS.filter((p) => p.pivotModelId)
  t.ok(pivotPairs.length >= 2, 'at least IT<->ID pivot pairs configured')
  const itid = DEFAULT_PAIRS.find((p) => p.from === 'it' && p.to === 'id')
  t.is(itid?.pivotModelId, 'bergamot-en-id', 'IT->ID pivots via en-id')
  t.is(itid?.via, 'en', 'IT->ID pivots via English')
})

// -- Fix Wave C T1: native pivot via modelConfig.pivotModel -----------------

test('pivot pair passes pivotModelPath + pivotSourceLang/pivotTargetLang to engine.loadModel', async (t) => {
  const tmp = makeTmpDir()
  const bytesA = crypto.randomBytes(16)
  const bytesB = crypto.randomBytes(16)
  const models = [
    { id: 'bergamot-it-en', contentDigest: sha256Hex(bytesA), size: bytesA.length },
    { id: 'bergamot-en-id', contentDigest: sha256Hex(bytesB), size: bytesB.length }
  ]
  const bodyByUrl = new Map([
    ['https://fake/qvac/models/bergamot-it-en/download', bytesA],
    ['https://fake/qvac/models/bergamot-en-id/download', bytesB]
  ])
  const engine = makeFakeEngine()

  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models }),
    engineFactory: () => engine,
    fetchImpl: makeFakeFetch(bodyByUrl),
    // The IT->ID entry from DEFAULT_PAIRS carries pivotModelId + via='en'.
    pairs: [
      { from: 'it', to: 'en', modelId: 'bergamot-it-en' },
      { from: 'en', to: 'id', modelId: 'bergamot-en-id' },
      { from: 'it', to: 'id', modelId: 'bergamot-it-en', pivotModelId: 'bergamot-en-id', via: 'en' }
    ],
    timeoutMs: 3000
  })

  // Find the pivot load call.
  const pivotLoad = engine.loaded.find((l) => l.sourceLang === 'it' && l.targetLang === 'id')
  t.ok(pivotLoad, 'pivot pair went through loadModel')
  t.ok(pivotLoad.pivotModelPath, 'pivotModelPath passed to engine')
  t.ok(pivotLoad.pivotModelPath.includes('bergamot-en-id'), 'pivotModelPath points at en-id model')
  t.is(pivotLoad.pivotSourceLang, 'en', 'pivotSourceLang is en')
  t.is(pivotLoad.pivotTargetLang, 'id', 'pivotTargetLang is id')

  // Fast path: single engine.translate call when the pivot pair is loaded.
  const out = await tr.translate({ text: 'ciao', from: 'it', to: 'id' })
  t.is(out, '[it->id] ciao', 'single translate call routed via loaded pivot pair')

  await tr.close()
  tmp.cleanup()
})

// -- Fix Wave C T4: state() for the About integrity badge -------------------

test('state() returns loaded models, mode, and networkCallsThisSession', async (t) => {
  const tmp = makeTmpDir()
  const modelBytes = crypto.randomBytes(64)
  const models = [{
    id: 'bergamot-it-en',
    contentDigest: 'sha256:' + sha256Hex(modelBytes),
    size: modelBytes.byteLength
  }]
  const bodyByUrl = new Map([
    ['https://fake/qvac/models/bergamot-it-en/download', modelBytes]
  ])
  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models }),
    engineFactory: () => makeFakeEngine(),
    fetchImpl: makeFakeFetch(bodyByUrl),
    pairs: [{ from: 'it', to: 'en', modelId: 'bergamot-it-en' }],
    timeoutMs: 3000
  })

  const s = tr.state()
  t.is(s.mode, 'ready', 'mode reports ready')
  t.is(s.networkCallsThisSession, 0, 'no per-message network calls in on-device mode')
  t.is(s.loadedModels.length, 1, 'one loaded model reported')
  t.is(s.loadedModels[0].pair, 'it>en', 'pair key present')
  t.ok(typeof s.loadedModels[0].digest === 'string' && s.loadedModels[0].digest.length === 12,
    'short 12-char digest for the badge')

  await tr.close()
  const sClosed = tr.state()
  t.is(sClosed.mode, 'disabled', 'mode flips to disabled after close')
  tmp.cleanup()
})

test('state() from makeDisabled surface returns disabled mode', (t) => {
  const disabledTr = _internal.makeDisabled('no engine')
  const s = disabledTr.state()
  t.is(s.mode, 'disabled')
  t.is(s.loadedModels.length, 0)
  t.is(s.networkCallsThisSession, 0)
})

// -- close() -----------------------------------------------------------------

test('close() marks translator disabled', async (t) => {
  const tmp = makeTmpDir()
  const modelBytes = crypto.randomBytes(16)
  const models = [{ id: 'm1', contentDigest: sha256Hex(modelBytes), size: modelBytes.length }]
  const bodyByUrl = new Map([['https://fake/qvac/models/m1/download', modelBytes]])
  const tr = await createTranslator({
    storageDir: tmp.dir,
    backendClient: makeFakeBackend({ models }),
    engineFactory: () => makeFakeEngine(),
    fetchImpl: makeFakeFetch(bodyByUrl),
    pairs: [{ from: 'it', to: 'id', modelId: 'm1' }],
    timeoutMs: 2000
  })

  t.ok(tr.status().ready)
  await tr.close()
  t.absent(tr.status().ready)
  await t.exception.all(() => tr.translate({ text: 'hi', from: 'it', to: 'id' }), 'translate rejects after close')
  tmp.cleanup()
})
