// Wave 12: QVAC P2P Delegated Inference tests.
//
// Real @qvac/sdk 0.14.0 exposes startQVACProvider / stopQVACProvider and
// loadModel({delegate}) natively (dist/schemas/delegate.d.ts). These tests
// exercise Curva's wrapper via injectable seams so the DHT is never touched:
//
//   - `delegateTransport` on createTranslator: fake sync round-trip
//   - `sdkFactory` on startProvider: fake sdk with success/failure paths
//   - `roomState`: in-memory Map with put/get shape matching Hyperbee (JSON valueEncoding)
//
// Baseline: 269 tests. Wave 12 adds 7.

const test = require('brittle')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const {
  createTranslator,
  checkRateLimit,
  DEFAULT_PROVIDER_RATE_LIMIT_PER_MIN,
  _internal
} = require('../bare/translate.js')

const {
  startProvider,
  readProviderPubkey,
  PROVIDER_KEY_HYPERBEE_PATH,
  createSdkDelegateTransport
} = require('../bare/delegatedProvider.js')

// -- shared helpers --------------------------------------------------------

let counter = 0
function makeTmpDir () {
  const dir = path.join(os.tmpdir(), `curva-delegate-${process.pid}-${Date.now()}-${counter++}`)
  fs.mkdirSync(dir, { recursive: true })
  return { dir, cleanup () { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ } } }
}

function makeFakeEngine () {
  const loaded = []
  return {
    loaded,
    async loadModel (opts) { loaded.push(opts) },
    async translate ({ sourceLang, targetLang, text }) {
      return `[LOCAL ${sourceLang}->${targetLang}] ${text}`
    },
    async close () { loaded.length = 0 }
  }
}

async function buildTranslator (extra = {}) {
  const tmp = makeTmpDir()
  // Pre-seed the qvac-models directory + files BEFORE createTranslator inspects
  // them. Zero-byte files are fine because we pass no digest.the "no digest,
  // cached" branch accepts existing files as-is (ARCHITECTURE 12.2 escape hatch).
  const modelDir = path.join(tmp.dir, 'qvac-models')
  fs.mkdirSync(modelDir, { recursive: true })
  for (const id of ['bergamot-en-it', 'bergamot-it-en']) {
    fs.writeFileSync(path.join(modelDir, id), Buffer.alloc(4))
  }
  const t = await createTranslator({
    storageDir: tmp.dir,
    backendClient: null,
    pairs: [
      { from: 'en', to: 'it', modelId: 'bergamot-en-it' },
      { from: 'it', to: 'en', modelId: 'bergamot-it-en' }
    ],
    engineFactory: () => makeFakeEngine(),
    onProgress: () => {},
    onError: () => {},
    ...extra
  })
  return { t, tmp }
}

// A hand-rolled Hyperbee stand-in with JSON valueEncoding semantics. Curva's
// room.js opens the roomState Hyperbee with `valueEncoding: 'json'`, so put()
// stores the object directly and get() returns { value: <object> }.
function makeFakeHyperbee () {
  const store = new Map()
  return {
    async put (k, v) { store.set(k, v) },
    async get (k) {
      if (!store.has(k)) return null
      return { key: k, value: store.get(k) }
    }
  }
}

// -- Tests -----------------------------------------------------------------

test('Wave 12: provider startup happy path publishes pubkey to roomState', async (t) => {
  const roomState = makeFakeHyperbee()
  const statuses = []
  const fakeSdk = {
    async startQVACProvider () {
      return { type: 'provide', success: true, publicKey: 'a'.repeat(64) }
    },
    async stopQVACProvider () { return { type: 'stopProvide', success: true } }
  }
  const provider = await startProvider({
    sdkFactory: () => fakeSdk,
    seedHex: 'b'.repeat(64),
    roomState,
    onStatus: (evt) => statuses.push(evt),
    envSetter: () => {}
  })
  t.is(provider.publicKey, 'a'.repeat(64), 'pubkey lowercased and returned')

  const stored = await readProviderPubkey(roomState)
  t.is(stored, 'a'.repeat(64), 'pubkey persisted at qvac/provider-pubkey')

  const phases = statuses.map((s) => s.phase)
  t.ok(phases.includes('started'), 'started status emitted')
  t.ok(phases.includes('published'), 'published status emitted')

  await provider.stop()
})

test('Wave 12: guest delegate happy path routes through transport', async (t) => {
  const { t: translator, tmp } = await buildTranslator({
    delegateTransport: async ({ text, from, to }) => `[DELEGATE ${from}->${to}] ${text}`,
    getProviderPubkey: () => 'c'.repeat(64),
    onDelegateStatus: () => {},
    delegateEnabled: true
  })
  const out = await translator.translate({ text: 'hello', from: 'en', to: 'it' })
  t.is(out, '[DELEGATE en->it] hello', 'delegate transport served the response')
  await translator.close()
  tmp.cleanup()
})

test('Wave 12: guest falls back to local on 3s timeout', async (t) => {
  const events = []
  const { t: translator, tmp } = await buildTranslator({
    delegateTransport: async () => {
      const err = new Error('timeout'); err.code = 'DELEGATE_TIMEOUT'; throw err
    },
    getProviderPubkey: () => 'd'.repeat(64),
    onDelegateStatus: (evt) => events.push(evt),
    delegateEnabled: true,
    delegateTimeoutMs: 50
  })
  const out = await translator.translate({ text: 'hello', from: 'en', to: 'it' })
  t.is(out, '[LOCAL en->it] hello', 'local engine served after delegate timeout')
  t.ok(events.length > 0, 'delegate-status fired')
  t.is(events[0].fallback, true, 'fallback flag set')
  t.is(events[0].reason, 'timeout', 'reason is timeout')
  await translator.close()
  tmp.cleanup()
})

test('Wave 12: guest falls back to local when providerPubkey is empty', async (t) => {
  const transportCalls = []
  const { t: translator, tmp } = await buildTranslator({
    delegateTransport: async (...args) => { transportCalls.push(args); return 'wont happen' },
    getProviderPubkey: () => null,
    delegateEnabled: true
  })
  const out = await translator.translate({ text: 'hi', from: 'en', to: 'it' })
  t.is(out, '[LOCAL en->it] hi', 'local path when no provider pubkey')
  t.is(transportCalls.length, 0, 'transport was NOT invoked')
  await translator.close()
  tmp.cleanup()
})

test('Wave 12: rate limit rejects the 51st request in a sliding minute', async (t) => {
  const store = new Map()
  const remote = 'peer-a'
  let allowed = 0
  let rejected = 0
  for (let i = 0; i < DEFAULT_PROVIDER_RATE_LIMIT_PER_MIN + 5; i++) {
    if (checkRateLimit(store, remote, DEFAULT_PROVIDER_RATE_LIMIT_PER_MIN)) allowed++
    else rejected++
  }
  t.is(allowed, DEFAULT_PROVIDER_RATE_LIMIT_PER_MIN, '50 requests allowed')
  t.is(rejected, 5, '5 requests rejected as RATE_LIMITED')

  // A different remote is NOT affected by the first remote's history.
  t.ok(checkRateLimit(store, 'peer-b', DEFAULT_PROVIDER_RATE_LIMIT_PER_MIN),
    'per-peer sliding window is isolated')
})

test('Wave 12: feature flag off forces local path even with provider pubkey present', async (t) => {
  const transportCalls = []
  const { t: translator, tmp } = await buildTranslator({
    delegateTransport: async () => { transportCalls.push(1); return 'delegated' },
    getProviderPubkey: () => 'e'.repeat(64),
    delegateEnabled: false // simulates CURVA_QVAC_DELEGATE_ENABLED=0
  })
  const out = await translator.translate({ text: 'hi', from: 'en', to: 'it' })
  t.is(out, '[LOCAL en->it] hi', 'local path taken')
  t.is(transportCalls.length, 0, 'transport not called when flag is off')
  await translator.close()
  tmp.cleanup()
})

test('Wave 12: deterministic-handle provider pubkey renders via identity.handleFromPubkey', async (t) => {
  const { handleFromPubkey } = require('../bare/identity.js')
  const pubkey = 'f'.repeat(64)
  const handle = handleFromPubkey(pubkey)
  t.ok(typeof handle === 'string' && handle.length > 0, 'handle string returned')
  t.is(handle, handleFromPubkey(pubkey), 'deterministic: same input yields same output')
  // The chip renderer only needs SOMETHING deterministic + short. Existing
  // handleFromPubkey format is `word-color-nn`; any structure is fine here.
  t.ok(/[a-z]+-[a-z]+-\d+/i.test(handle), 'handle matches word-color-number shape')
})
