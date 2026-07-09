// Wave 12: host-side QVAC provider helper.
//
// Wraps @qvac/sdk's `startQVACProvider` / `stopQVACProvider` per the official
// docs at https://docs.qvac.tether.io/p2p-capabilities/delegated-inference/.
//
// Responsibilities:
//   1. Start a provider bound to a deterministic keypair (derived from the
//      host's Corestore seed so the pubkey survives restarts). The SDK reads
//      QVAC_HYPERSWARM_SEED from env for that.
//   2. Rate-limit inbound delegate requests: 50/min per remote pubkey by
//      default. The SDK's `firewall.publicKeys` allowlist is orthogonal.we
//      accept anyone but throttle noisy peers.
//   3. Publish the provider pubkey to the room's Hyperbee under
//      `qvac/provider-pubkey` so guests can pick it up on join.
//   4. Emit lifecycle status via a `onStatus` hook so workers/main.js can
//      forward to the renderer as translate:delegate-status events.
//
// All external effects are injectable so brittle tests never touch the DHT.
// Prod bindings:
//   sdkFactory  -> async () => require('@qvac/sdk')
//   roomState   -> the Hyperbee returned by openRoom()
//   seedProvider -> deterministic 32-byte seed (host Corestore primary key)
//
// Test bindings pass a fake sdk with `startQVACProvider` / `stopQVACProvider`
// stubs and skip roomState by omitting it.

const b4a = require('b4a')

const {
  checkRateLimit,
  DEFAULT_PROVIDER_RATE_LIMIT_PER_MIN,
  delegateFlagEnabled
} = require('./translate.js')

const PROVIDER_KEY_HYPERBEE_PATH = 'qvac/provider-pubkey'

/**
 * @typedef {Object} ProviderInstance
 * @property {string|null} publicKey - hex, 64 chars, lowercased. Null when not started.
 * @property {() => Promise<void>} stop
 * @property {(remoteKey: string) => boolean} allowRequest - rate-limit check
 * @property {() => { publicKey: string|null, requestsLastMin: number }} snapshot
 */

/**
 * @param {{
 *   sdkFactory?: () => Promise<any>|any,
 *   seedHex?: string|null,          // 64-char hex; enables deterministic identity
 *   roomState?: any|null,           // Hyperbee, optional
 *   perMinRateLimit?: number,
 *   onStatus?: (evt: {phase: string, publicKey?: string, error?: string}) => void,
 *   envSetter?: (key: string, value: string) => void   // test seam
 * }} opts
 * @returns {Promise<ProviderInstance>}
 */
async function startProvider (opts = {}) {
  const {
    sdkFactory = async () => {
      try { return await import('@qvac/sdk') } catch { return null }
    },
    seedHex = null,
    roomState = null,
    perMinRateLimit = DEFAULT_PROVIDER_RATE_LIMIT_PER_MIN,
    onStatus = () => {},
    envSetter = (k, v) => { if (typeof process !== 'undefined' && process.env) process.env[k] = v }
  } = opts

  if (!delegateFlagEnabled()) {
    safeStatus(onStatus, { phase: 'disabled', error: 'CURVA_QVAC_DELEGATE_ENABLED=0' })
    return makeInactiveProvider()
  }

  // Deterministic identity per docs: QVAC_HYPERSWARM_SEED (64-char hex).
  // We set it BEFORE requiring the SDK so the sdk picks it up at import time
  // if it caches env on load. Prod call sites derive `seedHex` from the host
  // Corestore primary key namespaced with a Curva label so it's stable but
  // does not leak the raw corestore key.
  if (typeof seedHex === 'string' && /^[0-9a-f]{64}$/i.test(seedHex)) {
    try { envSetter('QVAC_HYPERSWARM_SEED', seedHex.toLowerCase()) } catch { /* noop */ }
  }

  const sdk = await Promise.resolve().then(() => sdkFactory()).catch(() => null)
  if (!sdk || typeof sdk.startQVACProvider !== 'function') {
    safeStatus(onStatus, { phase: 'sdk-missing', error: 'startQVACProvider not exported' })
    return makeInactiveProvider()
  }

  let publicKey = null
  const rateStore = new Map()   // remoteKey -> [timestamps]

  try {
    // Per docs: startQVACProvider is idempotent when called with a running
    // provider.safe to invoke on every openRoom() for a host.
    const res = await sdk.startQVACProvider({})
    if (!res || res.success === false || typeof res.publicKey !== 'string') {
      safeStatus(onStatus, { phase: 'start-failed', error: res?.error || 'unknown' })
      return makeInactiveProvider()
    }
    publicKey = res.publicKey.toLowerCase()
  } catch (err) {
    safeStatus(onStatus, { phase: 'start-failed', error: err?.message || 'threw' })
    return makeInactiveProvider()
  }

  safeStatus(onStatus, { phase: 'started', publicKey })

  // Publish to room Hyperbee so guests can discover on join. Non-fatal on
  // failure.the room degrades to local-only translation for guests.
  if (roomState && typeof roomState.put === 'function') {
    try {
      await roomState.put(PROVIDER_KEY_HYPERBEE_PATH, {
        publicKey,
        at: Date.now()
      })
      safeStatus(onStatus, { phase: 'published', publicKey })
    } catch (err) {
      safeStatus(onStatus, { phase: 'publish-failed', error: err?.message || 'threw' })
    }
  }

  return {
    publicKey,
    async stop () {
      if (typeof sdk.stopQVACProvider === 'function') {
        try { await sdk.stopQVACProvider() } catch { /* noop */ }
      }
      safeStatus(onStatus, { phase: 'stopped' })
    },
    allowRequest (remoteKey) {
      return checkRateLimit(rateStore, remoteKey, perMinRateLimit)
    },
    snapshot () {
      let total = 0
      for (const arr of rateStore.values()) total += arr.length
      return { publicKey, requestsLastMin: total }
    }
  }
}

function makeInactiveProvider () {
  return {
    publicKey: null,
    async stop () { /* noop */ },
    allowRequest () { return false },
    snapshot () { return { publicKey: null, requestsLastMin: 0 } }
  }
}

function safeStatus (fn, evt) {
  try { fn(evt) } catch { /* status hook is best-effort */ }
}

/**
 * Read the room's advertised provider pubkey from the Hyperbee. Returns null
 * if absent or malformed. Guests call this on room open.
 * @param {any} roomState Hyperbee instance
 * @returns {Promise<string|null>}
 */
async function readProviderPubkey (roomState) {
  if (!roomState || typeof roomState.get !== 'function') return null
  try {
    const node = await roomState.get(PROVIDER_KEY_HYPERBEE_PATH)
    if (!node || !node.value) return null
    // Hyperbee returns Buffer values by default; JSON-encoded when written via
    // `put(x, obj)` (Hyperbee auto-serializes when configured with a JSON
    // valueEncoding.Curva sets that in room.js). Handle both.
    let v = node.value
    if (b4a.isBuffer(v) || v instanceof Uint8Array) {
      try { v = JSON.parse(b4a.toString(v)) } catch { return null }
    }
    if (v && typeof v.publicKey === 'string' && /^[0-9a-f]{64}$/i.test(v.publicKey)) {
      return v.publicKey.toLowerCase()
    }
    return null
  } catch { return null }
}

/**
 * Build a delegate transport that speaks to a QVAC provider via the SDK's
 * native `translate({modelId, ...})` path with a delegate-registered modelId.
 *
 * Prod flow:
 *   - Guest calls `loadModel({modelSrc, delegate:{providerPublicKey, timeout,
 *     fallbackToLocal:false}})` once per (from,to) pair on first request.
 *   - `translate({modelId})` is then routed through the SDK's delegate RPC
 *     transport (dist/server/rpc/delegate-transport.js).
 *
 * We pass `fallbackToLocal: false` so the transport surfaces failures back to
 * Curva's own fallback logic in translate.js (which emits delegate-status).
 *
 * Test flow: caller passes `sdk` = {loadModel, translate} stubs.
 *
 * @param {{
 *   sdkFactory?: () => Promise<any>|any,
 *   modelSrcResolver: (opts: {from:string,to:string}) => string|null,
 *   defaultTimeoutMs?: number
 * }} opts
 * @returns {(req: {providerPublicKey:string, text:string, from:string, to:string, timeoutMs:number}) => Promise<string>}
 */
function createSdkDelegateTransport (opts = {}) {
  const {
    sdkFactory = async () => { try { return await import('@qvac/sdk') } catch { return null } },
    modelSrcResolver,
    defaultTimeoutMs = 3_000
  } = opts

  if (typeof modelSrcResolver !== 'function') {
    throw new TypeError('modelSrcResolver is required')
  }

  const modelIdByKey = new Map() // "provider|from>to" -> modelId
  let cachedSdk = null

  async function getSdk () {
    if (cachedSdk) return cachedSdk
    cachedSdk = await sdkFactory()
    return cachedSdk
  }

  return async function delegateTransport ({ providerPublicKey, text, from, to, timeoutMs } = {}) {
    if (typeof providerPublicKey !== 'string' || !/^[0-9a-f]{64}$/i.test(providerPublicKey)) {
      throw withCode('DELEGATE_BAD_KEY', 'invalid provider public key')
    }
    const cacheKey = providerPublicKey + '|' + from + '>' + to
    const sdk = await getSdk()
    if (!sdk || typeof sdk.loadModel !== 'function' || typeof sdk.translate !== 'function') {
      throw withCode('SDK_UNAVAILABLE', '@qvac/sdk not loaded')
    }

    let modelId = modelIdByKey.get(cacheKey)
    if (!modelId) {
      const modelSrc = modelSrcResolver({ from, to })
      if (!modelSrc) throw withCode('NO_MODEL_SRC', `no modelSrc for ${from}->${to}`)
      const loaded = await withTimeout(sdk.loadModel({
        modelSrc,
        modelType: 'nmt',
        modelConfig: { engine: 'Bergamot', from, to },
        delegate: {
          providerPublicKey,
          timeout: timeoutMs || defaultTimeoutMs,
          fallbackToLocal: false
        }
      }), timeoutMs || defaultTimeoutMs)
      modelId = loaded
      modelIdByKey.set(cacheKey, modelId)
    }

    const result = sdk.translate({
      modelId,
      text,
      modelType: 'nmt',
      stream: false
    })
    return await withTimeout(Promise.resolve(result?.text ?? result), timeoutMs || defaultTimeoutMs)
  }
}

function withTimeout (promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new Error('delegate timeout after ' + ms + 'ms')
      err.code = 'DELEGATE_TIMEOUT'
      reject(err)
    }, Math.max(1, ms | 0))
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) }
    )
  })
}

function withCode (code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

// =========================================================================
// Semifinal QVAC depth: delegated inference discovery + ping + firewall API.
//
// The renderer's DelegatedInferencePanel needs to (1) list every provider the
// room knows about, (2) test connectivity to any one of them, and (3) swap
// the firewall allow/deny list without restarting the whole room. This block
// wraps @qvac/sdk's `startQVACProvider({firewall})`, `loadModel({delegate})`,
// and a Hyperbee sub-index into a single directory-style API.
//
// Docs: https://docs.qvac.tether.io/p2p-capabilities/delegated-inference/
// (firewall + delegate sections, fetched 2026-07-10). SDK types verified
// against pear-app/node_modules/@qvac/sdk/dist/schemas/delegate.d.ts.
// =========================================================================

const PROVIDER_INDEX_PREFIX = 'curva/providers/'
const DEFAULT_PING_TIMEOUT_MS = 5_000
// Small model constant used for connectivity checks. Bergamot NMT is a real
// on-registry entry (see backend/src/data/qvac-models.json); a load through
// a delegate provider validates the transport without paying a >100 MB
// download cost.
const PING_MODEL_SRC = 'BERGAMOT_EN_IT'

/**
 * @param {{
 *   sdkFactory?: () => Promise<any>|any,
 *   roomState?: any,                // Hyperbee (JSON valueEncoding)
 *   ownerDeviceProof?: string|null,  // opaque host proof, opaque to renderer
 *   perMinRateLimit?: number,
 *   emit?: (event: string, payload: any) => void,
 *   onStatus?: (evt: any) => void
 * }} opts
 */
function createDelegatedRegistry (opts = {}) {
  const {
    sdkFactory = async () => { try { return await import('@qvac/sdk') } catch { return null } },
    roomState = null,
    ownerDeviceProof = null,
    perMinRateLimit = DEFAULT_PROVIDER_RATE_LIMIT_PER_MIN,
    emit = () => {},
    onStatus = () => {}
  } = opts

  const state = {
    started: false,
    publicKey: null,
    firewall: { mode: 'allow', publicKeys: [] },
    provider: null,      // ProviderInstance from startProvider()
    lastError: null
  }

  let cachedSdk = null
  async function getSdk () {
    if (cachedSdk) return cachedSdk
    cachedSdk = await sdkFactory()
    return cachedSdk
  }

  function normalizeFirewall (cfg) {
    const mode = cfg && (cfg.mode === 'deny' ? 'deny' : 'allow')
    const publicKeys = Array.isArray(cfg?.publicKeys)
      ? cfg.publicKeys
        .filter((k) => typeof k === 'string' && /^[0-9a-f]{64}$/i.test(k))
        .map((k) => k.toLowerCase())
      : []
    return { mode, publicKeys }
  }

  /**
   * Start (or re-start) the provider with an explicit firewall config. Called
   * on room-open by the host. Guests do NOT start a provider.
   */
  async function start (firewallCfg = null) {
    const firewall = normalizeFirewall(firewallCfg || state.firewall)
    state.firewall = firewall
    const sdk = await getSdk()
    if (!sdk || typeof sdk.startQVACProvider !== 'function') {
      state.lastError = 'startQVACProvider not exported'
      emit('delegated:error', { code: 'SDK_UNAVAILABLE', message: state.lastError })
      return { started: false, error: state.lastError }
    }
    try {
      // The SDK accepts an explicit firewall config per the docs.
      const res = await sdk.startQVACProvider({ firewall })
      if (!res || typeof res.publicKey !== 'string') {
        state.lastError = res?.error || 'no publicKey returned'
        emit('delegated:error', { code: 'START_FAILED', message: state.lastError })
        return { started: false, error: state.lastError }
      }
      state.publicKey = res.publicKey.toLowerCase()
      state.started = true
      state.lastError = null
      // Publish our own entry so guests see us in listProviders().
      await publishProvider({
        publicKey: state.publicKey,
        models: [PING_MODEL_SRC],
        ownerDeviceProof: ownerDeviceProof || null
      })
      const status = { started: true, publicKey: state.publicKey, firewall }
      onStatus({ phase: 'started', ...status })
      emit('delegated:started', status)
      return status
    } catch (err) {
      state.lastError = (err && err.message) || 'threw'
      emit('delegated:error', { code: 'START_FAILED', message: state.lastError })
      return { started: false, error: state.lastError }
    }
  }

  /** Stop the provider gracefully. Non-throwing. */
  async function stop () {
    const sdk = await getSdk()
    if (sdk && typeof sdk.stopQVACProvider === 'function') {
      try { await sdk.stopQVACProvider() } catch { /* noop */ }
    }
    state.started = false
    state.publicKey = null
    emit('delegated:stopped', {})
  }

  /**
   * Hot-swap the firewall. The SDK does NOT expose a runtime setFirewall
   * primitive so we stop+start. Documented behavior: existing delegate
   * sessions survive because the provider pubkey stays the same (deterministic
   * seed).
   */
  async function setFirewall (cfg) {
    const next = normalizeFirewall(cfg)
    if (!state.started) {
      state.firewall = next
      return { firewall: next, restarted: false }
    }
    // Restart in place. The seed env var (QVAC_HYPERSWARM_SEED) means the
    // pubkey survives, so peers do not need to re-discover.
    await stop()
    const res = await start(next)
    return { firewall: next, restarted: !!res.started }
  }

  /**
   * Write a `curva/providers/<pubkey>` entry to the room's Hyperbee. Idempotent.
   */
  async function publishProvider ({ publicKey, models = [], ownerDeviceProof: proof = null } = {}) {
    if (!roomState || typeof roomState.put !== 'function') return false
    if (typeof publicKey !== 'string' || !/^[0-9a-f]{64}$/i.test(publicKey)) return false
    const key = PROVIDER_INDEX_PREFIX + publicKey.toLowerCase()
    const value = {
      pubkey: publicKey.toLowerCase(),
      models: Array.isArray(models) ? models.slice(0, 16).map((m) => String(m)) : [],
      addedAt: Date.now(),
      ownerDeviceProof: proof || null
    }
    try {
      await roomState.put(key, value)
      return true
    } catch (err) {
      emit('delegated:error', { code: 'PUBLISH_FAILED', message: err && err.message })
      return false
    }
  }

  /**
   * List all providers from the room's Hyperbee. Returns an array of entries;
   * empty when no roomState is wired (offline demo) or the range is empty.
   */
  async function listProviders () {
    if (!roomState || typeof roomState.createReadStream !== 'function') {
      // Fallback for tests: some in-memory stubs expose a plain Map iterator.
      if (roomState && typeof roomState.entries === 'function') {
        const out = []
        for (const [k, v] of roomState.entries()) {
          if (typeof k === 'string' && k.startsWith(PROVIDER_INDEX_PREFIX)) {
            out.push({ ...(v || {}) })
          }
        }
        return out
      }
      return []
    }
    const rows = []
    const gte = PROVIDER_INDEX_PREFIX
    const lte = PROVIDER_INDEX_PREFIX + '~'   // ASCII sentinel: '~' > 'f'
    try {
      const stream = roomState.createReadStream({ gte, lte })
      for await (const node of stream) {
        let v = node && node.value
        if (v && typeof v === 'object' && (v.byteLength || v instanceof Uint8Array)) {
          try { v = JSON.parse(Buffer.from(v).toString('utf8')) } catch { v = null }
        }
        if (!v || typeof v !== 'object') continue
        if (typeof v.pubkey === 'string' && /^[0-9a-f]{64}$/i.test(v.pubkey)) {
          rows.push({
            pubkey: v.pubkey.toLowerCase(),
            models: Array.isArray(v.models) ? v.models.slice(0, 16) : [],
            addedAt: Number(v.addedAt) || 0,
            ownerDeviceProof: v.ownerDeviceProof || null
          })
        }
      }
    } catch (err) {
      emit('delegated:error', { code: 'LIST_FAILED', message: err && err.message })
    }
    // Sort by addedAt desc for a stable UI.
    rows.sort((a, b) => b.addedAt - a.addedAt)
    return rows
  }

  /**
   * Round-trip a delegate loadModel() call against `providerPublicKey`.
   * Returns `{ ok, roundTripMs, error }`. Uses a tiny model (`PING_MODEL_SRC`)
   * with `fallbackToLocal:false` so the transport failure surfaces cleanly.
   */
  async function pingProvider (providerPublicKey, { timeoutMs = DEFAULT_PING_TIMEOUT_MS, modelSrc = PING_MODEL_SRC } = {}) {
    if (typeof providerPublicKey !== 'string' || !/^[0-9a-f]{64}$/i.test(providerPublicKey)) {
      return { ok: false, roundTripMs: null, error: 'bad pubkey' }
    }
    const sdk = await getSdk()
    if (!sdk || typeof sdk.loadModel !== 'function') {
      return { ok: false, roundTripMs: null, error: 'SDK unavailable' }
    }
    const started = Date.now()
    try {
      await withTimeout(sdk.loadModel({
        modelSrc,
        modelType: 'nmt',
        delegate: {
          providerPublicKey: providerPublicKey.toLowerCase(),
          timeout: timeoutMs,
          fallbackToLocal: false,
          forceNewConnection: false
        }
      }), timeoutMs)
      const roundTripMs = Date.now() - started
      emit('delegated:pinged', { pubkey: providerPublicKey.toLowerCase(), ok: true, roundTripMs })
      return { ok: true, roundTripMs, error: null }
    } catch (err) {
      const roundTripMs = Date.now() - started
      const message = (err && err.message) || 'ping failed'
      emit('delegated:pinged', { pubkey: providerPublicKey.toLowerCase(), ok: false, roundTripMs, error: message })
      return { ok: false, roundTripMs, error: message }
    }
  }

  function snapshot () {
    return {
      started: state.started,
      publicKey: state.publicKey,
      firewall: { ...state.firewall, publicKeys: state.firewall.publicKeys.slice() },
      lastError: state.lastError
    }
  }

  return {
    start,
    stop,
    setFirewall,
    publishProvider,
    listProviders,
    pingProvider,
    snapshot,
    _internal: { state, normalizeFirewall }
  }
}

module.exports = {
  startProvider,
  readProviderPubkey,
  createSdkDelegateTransport,
  createDelegatedRegistry,
  PROVIDER_KEY_HYPERBEE_PATH,
  PROVIDER_INDEX_PREFIX,
  DEFAULT_PING_TIMEOUT_MS,
  PING_MODEL_SRC,
  _internal: { withTimeout, withCode, makeInactiveProvider }
}
