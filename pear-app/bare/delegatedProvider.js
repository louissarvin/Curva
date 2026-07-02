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

module.exports = {
  startProvider,
  readProviderPubkey,
  createSdkDelegateTransport,
  PROVIDER_KEY_HYPERBEE_PATH,
  _internal: { withTimeout, withCode, makeInactiveProvider }
}
