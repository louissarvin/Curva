// Wave 4 F2: getModelSnapshot + startModelLogRing unit tests for
// bare/observability.js.
//
// Verified against installed .d.ts (0.14.0):
//   node_modules/@qvac/sdk/dist/client/api/get-model-info.d.ts:10-42
//   node_modules/@qvac/sdk/dist/client/api/get-loaded-model-info.d.ts:24
//   node_modules/@qvac/sdk/dist/client/api/subscribe-logs.d.ts:27
//
// We inject a fake SDK — the real @qvac/sdk is not touched.

const test = require('brittle')
const {
  getModelSnapshot,
  startModelLogRing,
  DEFAULT_MODEL_LOG_RING_SIZE,
  _internal
} = require('../bare/observability.js')

// --- fake SDK builder -----------------------------------------------------

function makeSdk ({
  models = {},       // name -> getModelInfo result (or Error)
  loaded = {},       // modelId -> getLoadedModelInfo result (or Error)
  logStream = null   // (handler) => unsubscribeFn (or null to skip)
} = {}) {
  return {
    async getModelInfo ({ name }) {
      const v = models[name]
      if (v instanceof Error) throw v
      if (!v) throw Object.assign(new Error('unknown model'), { code: 'ModelNotFoundError' })
      return v
    },
    async getLoadedModelInfo ({ modelId }) {
      const v = loaded[modelId]
      if (v instanceof Error) throw v
      if (!v) throw Object.assign(new Error('not loaded'), { code: 'ModelNotFoundError' })
      return v
    },
    subscribeServerLogs: logStream || undefined
  }
}

// --- getModelSnapshot ------------------------------------------------------

test('getModelSnapshot returns [] when SDK is missing or malformed', async (t) => {
  t.alike(await getModelSnapshot(null, { allNames: ['a'] }), [])
  t.alike(await getModelSnapshot({}, { allNames: ['a'] }), [])
})

test('getModelSnapshot returns [] when allNames is empty or missing', async (t) => {
  const sdk = makeSdk({ models: { 'A': { name: 'A', modelId: 'a1', addon: 'llm', isCached: true, isLoaded: false, cacheFiles: [] } } })
  t.alike(await getModelSnapshot(sdk), [])
  t.alike(await getModelSnapshot(sdk, { allNames: [] }), [])
})

test('getModelSnapshot merges catalog info + loaded info', async (t) => {
  const sdk = makeSdk({
    models: {
      'SMOLVLM2': {
        name: 'SMOLVLM2',
        modelId: 'smolvlm2-id',
        expectedSize: 500_000_000,
        sha256Checksum: 'abc',
        addon: 'llm',
        isCached: true,
        isLoaded: true,
        cacheFiles: [
          { filename: 'model.gguf', path: '/x/model.gguf', expectedSize: 300_000_000, actualSize: 300_000_000, isCached: true },
          { filename: 'mmproj.gguf', path: '/x/mm.gguf', expectedSize: 200_000_000, actualSize: 200_000_000, isCached: true }
        ],
        loadedInstances: [{ registryId: 'r1', loadedAt: new Date() }]
      },
      'PARAKEET': {
        name: 'PARAKEET',
        modelId: 'parakeet-id',
        addon: 'parakeet',
        isCached: false,
        isLoaded: false,
        cacheFiles: []
      }
    },
    loaded: {
      'smolvlm2-id': {
        modelType: 'llm',
        handlers: ['completionStream', 'completion'],
        isDelegated: false,
        providerInfo: null
      }
    }
  })
  const snap = await getModelSnapshot(sdk, { allNames: ['SMOLVLM2', 'PARAKEET'] })
  t.is(snap.length, 2)

  const smol = snap[0]
  t.is(smol.name, 'SMOLVLM2')
  t.is(smol.modelId, 'smolvlm2-id')
  t.is(smol.addon, 'llm')
  t.is(smol.isLoaded, true)
  t.is(smol.isCached, true)
  t.is(smol.sizeBytes, 500_000_000, 'size sums cache file actualSize')
  t.alike(smol.handlers, ['completionStream', 'completion'], 'handlers from loaded info')
  t.is(smol.isDelegated, false)
  t.is(smol.loadedInstances, 1)
  t.is(smol.cacheFiles.length, 2)

  const par = snap[1]
  t.is(par.name, 'PARAKEET')
  t.is(par.isLoaded, false)
  t.alike(par.handlers, [], 'no handlers when not loaded')
})

test('getModelSnapshot surfaces per-model errors without dropping other rows', async (t) => {
  const sdk = makeSdk({
    models: {
      'BROKEN': new Error('boom'),
      'GOOD': { name: 'GOOD', modelId: 'g1', addon: 'llm', isCached: true, isLoaded: false, cacheFiles: [] }
    }
  })
  const snap = await getModelSnapshot(sdk, { allNames: ['BROKEN', 'GOOD'] })
  t.is(snap.length, 2)
  t.is(snap[0].name, 'BROKEN')
  t.is(snap[0].error, 'boom')
  t.is(snap[0].isLoaded, false)
  t.is(snap[1].name, 'GOOD', 'GOOD row unaffected')
})

test('getModelSnapshot treats getLoadedModelInfo failure as unloaded (race-safe)', async (t) => {
  // Simulate the race where getModelInfo says isLoaded:true but the model was
  // unloaded between the two RPCs — getLoadedModelInfo throws ModelNotFoundError.
  const sdk = makeSdk({
    models: {
      'RACY': {
        name: 'RACY',
        modelId: 'racy-id',
        addon: 'whisper',
        isCached: true,
        isLoaded: true,
        cacheFiles: [{ filename: 'w.gguf', path: '/w', expectedSize: 100, actualSize: 100, isCached: true }]
      }
    },
    loaded: {} // getLoadedModelInfo throws for racy-id
  })
  const snap = await getModelSnapshot(sdk, { allNames: ['RACY'] })
  t.is(snap.length, 1)
  t.is(snap[0].isLoaded, true, 'catalog says loaded — trust it')
  t.alike(snap[0].handlers, [], 'no handlers when getLoadedModelInfo threw')
  t.is(snap[0].isDelegated, false)
})

test('getModelSnapshot marks delegated models correctly', async (t) => {
  const sdk = makeSdk({
    models: {
      'REMOTE': {
        name: 'REMOTE',
        modelId: 'remote-id',
        addon: 'llm',
        isCached: false,
        isLoaded: true,
        cacheFiles: []
      }
    },
    loaded: {
      'remote-id': {
        modelType: 'llm',
        handlers: [],
        isDelegated: true,
        providerInfo: { publicKey: 'ff'.repeat(32) }
      }
    }
  })
  const snap = await getModelSnapshot(sdk, { allNames: ['REMOTE'] })
  t.is(snap[0].isDelegated, true)
  t.is(snap[0].providerPubkey, 'ff'.repeat(32))
})

// --- startModelLogRing -----------------------------------------------------

test('startModelLogRing returns an inert ring when subscribeServerLogs is missing', (t) => {
  const ring = startModelLogRing({}, {})
  t.alike(ring.get('any'), [])
  t.alike(ring.all(), {})
  ring.unsubscribe() // must not throw
})

test('startModelLogRing keys log entries by log.id and caps per-id', (t) => {
  let handler = null
  const sdk = makeSdk({
    logStream: (h) => { handler = h; return () => { handler = null } }
  })
  const ring = startModelLogRing(sdk, { maxPerId: 3 })
  handler({ level: 'info', id: 'model-A', namespace: 'llamacpp', message: 'l1' })
  handler({ level: 'info', id: 'model-A', namespace: 'llamacpp', message: 'l2' })
  handler({ level: 'info', id: 'model-B', namespace: 'whisper', message: 'l1' })
  handler({ level: 'info', id: 'model-A', namespace: 'llamacpp', message: 'l3' })
  handler({ level: 'info', id: 'model-A', namespace: 'llamacpp', message: 'l4' }) // pushes out l1

  const a = ring.get('model-A')
  t.is(a.length, 3, 'ring cap enforced per id')
  t.alike(a.map((e) => e.message), ['l2', 'l3', 'l4'], 'oldest evicted first')
  const b = ring.get('model-B')
  t.is(b.length, 1)
  t.is(b[0].message, 'l1')

  const all = ring.all()
  t.is(Object.keys(all).sort().join(','), 'model-A,model-B')

  ring.unsubscribe()
  t.alike(ring.get('model-A'), [], 'get returns [] after unsubscribe (buffers cleared)')
})

test('startModelLogRing uses default cap when maxPerId not supplied', (t) => {
  let handler = null
  const sdk = makeSdk({ logStream: (h) => { handler = h; return () => {} } })
  const ring = startModelLogRing(sdk)
  for (let i = 0; i < DEFAULT_MODEL_LOG_RING_SIZE + 10; i++) {
    handler({ level: 'info', id: 'X', namespace: 'n', message: 'line ' + i })
  }
  const entries = ring.get('X')
  t.is(entries.length, DEFAULT_MODEL_LOG_RING_SIZE, 'default 100-line cap')
  t.is(entries[0].message, 'line 10', 'oldest 10 evicted')
  ring.unsubscribe()
})

test('startModelLogRing skips log entries without an id', (t) => {
  let handler = null
  const sdk = makeSdk({ logStream: (h) => { handler = h; return () => {} } })
  const ring = startModelLogRing(sdk, {})
  handler({ level: 'info', id: null, message: 'orphan' })
  handler({ level: 'info', message: 'no id' })
  handler({ id: '', message: 'empty' })
  t.alike(ring.all(), {}, 'entries without id are dropped')
  ring.unsubscribe()
})

test('startModelLogRing clips oversized messages to 2 KB', (t) => {
  let handler = null
  const sdk = makeSdk({ logStream: (h) => { handler = h; return () => {} } })
  const ring = startModelLogRing(sdk, {})
  const huge = 'A'.repeat(10_000)
  handler({ level: 'info', id: 'model-A', message: huge })
  const entries = ring.get('model-A')
  t.is(entries.length, 1)
  t.is(entries[0].message.length, 2048, 'message clipped to 2KB')
  ring.unsubscribe()
})

test('startModelLogRing invokes optional onLog callback', (t) => {
  let handler = null
  const sdk = makeSdk({ logStream: (h) => { handler = h; return () => {} } })
  const seen = []
  const ring = startModelLogRing(sdk, { onLog: (e) => seen.push(e) })
  handler({ level: 'info', id: 'A', message: 'hi' })
  t.is(seen.length, 1)
  t.is(seen[0].id, 'A')
  t.is(seen[0].message, 'hi')
  ring.unsubscribe()
})

test('startModelLogRing swallows onLog callback errors', (t) => {
  let handler = null
  const sdk = makeSdk({ logStream: (h) => { handler = h; return () => {} } })
  const ring = startModelLogRing(sdk, { onLog: () => { throw new Error('boom') } })
  // Must not throw even though onLog throws.
  handler({ level: 'info', id: 'A', message: 'hi' })
  t.is(ring.get('A').length, 1, 'entry still stored despite callback throw')
  ring.unsubscribe()
})

test('startModelLogRing unsubscribe is idempotent', (t) => {
  let handler = null
  let unsubCalls = 0
  const sdk = makeSdk({
    logStream: (h) => { handler = h; return () => { unsubCalls++ } }
  })
  const ring = startModelLogRing(sdk, {})
  handler({ level: 'info', id: 'X', message: 'a' })
  ring.unsubscribe()
  ring.unsubscribe()
  ring.unsubscribe()
  t.is(unsubCalls, 1, 'underlying unsubscribe called exactly once')
})

test('_internal.normalizeModelLogEntry accepts alternate message field names', (t) => {
  const a = _internal.normalizeModelLogEntry({ id: 'x', text: 'hello' })
  t.is(a.message, 'hello')
  const b = _internal.normalizeModelLogEntry({ id: 'x', msg: 'hey' })
  t.is(b.message, 'hey')
  const c = _internal.normalizeModelLogEntry({ id: 'x' })
  t.is(c, null, 'no message => reject')
})
