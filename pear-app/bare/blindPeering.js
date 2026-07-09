// Wave 15: Blind-Peering client for Curva.
//
// Docs-verification memo
// ----------------------
// URLs consulted (2026-07-01):
//   https://docs.pears.com/how-to/blind-peering/add-blind-peering-to-a-chat-app/
//   https://github.com/holepunchto/blind-peering
//   pear-app/node_modules/blind-peering/index.js (installed version 2.4.0)
// Prompt-injection incidents: two docs fetches returned fake system-reminder
// blocks trying to change the date and inject unrelated MCP instructions.
// Ignored per Wave 15 instructions; API surface below is derived from the
// installed package source (authoritative).
//
// Installed API (blind-peering@2.4.0):
//   new BlindPeering(dht, corestore, {
//     keys: <Array<hex-key|hyperdht-encoded>>,  // list of blind-peer pubkeys
//     suspended, wakeup, gcWait, pick, relayThrough, ...
//   })
//   await bp.addAutobase(auto, { target?, referrer?, priority?, announce?,
//                                additionalViews?, pick?, keys? })
//   await bp.addCore(core, { target?, ... })
//   bp.addAutobaseBackground(auto, opts)
//   bp.addCoreBackground(core, opts)
//   await bp.suspend(); await bp.resume(); await bp.close()
//
// The installed BlindPeering constructor accepts the DHT instance directly, not
// the Hyperswarm. Curva's Hyperswarm is created with `new Hyperswarm(opts)` so
// its DHT is `swarm.dht` (verified in workers/main.js). We pass the DHT into
// this factory to match the docs-native pattern exactly. No shim required.
//
// The package's addAutobase already does its own retry/backoff (Backoff instance
// per BlindPeer). We layer a small "5 registrations per Autobase per minute"
// rate limit on the OUTBOUND call site because this is Curva-specific defense
// in depth (prevents a churn attack that keeps re-registering the same base).

const b4a = require('b4a')

// Rate-limit window: at most 5 register attempts per Autobase per rolling min.
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX = 5

// Env var: z-base-32 encoded pubkey of the third-party blind peer to register
// with. Empty default; when unset the feature no-ops.
const BLIND_PEER_KEY_ENV = 'CURVA_BLIND_PEER_KEY'

/**
 * Reads the CURVA_BLIND_PEER_KEY env var. Returns a trimmed string or empty
 * string. Never throws.
 * @returns {string}
 */
function getBlindPeerKey() {
  try {
    if (typeof process === 'undefined' || !process.env) return ''
    const v = process.env[BLIND_PEER_KEY_ENV]
    return (typeof v === 'string') ? v.trim() : ''
  } catch { return '' }
}

/**
 * Feature flag reader. Returns true only when CURVA_BLIND_PEERING_ENABLED is
 * exactly "true" (case-insensitive). Any other value (including unset) is off.
 * @returns {boolean}
 */
function blindPeeringFlagEnabled() {
  try {
    if (typeof process === 'undefined' || !process.env) return false
    const v = process.env.CURVA_BLIND_PEERING_ENABLED
    return String(v || '').toLowerCase() === 'true'
  } catch { return false }
}

/**
 * Injectable factory alias so tests can substitute a fake BlindPeering class
 * without monkey-patching require cache.
 */
function loadBlindPeeringClass() {
  return require('blind-peering')
}

/**
 * Create a Curva-wrapped blind-peering client.
 *
 * @param {{
 *   swarm: object,                 // Hyperswarm instance (must expose .dht)
 *   corestore: object,             // Corestore instance
 *   blindPeerKey?: string,         // z-base-32 pubkey; defaults to env
 *   enabled?: boolean,             // override the feature flag (tests)
 *   BlindPeeringClass?: Function,  // test injection
 *   logger?: {info,warn,error}     // structured logger
 * }} opts
 *
 * Returned surface:
 *   status()                          -> { enabled, peerKeyShort, registrationsCount, lastError }
 *   registerAutobase(base, opts?)     -> Promise<{ ok: boolean, reason?: string }>
 *   unregisterAutobase(base)          -> Promise<{ ok: boolean }>
 *   close()                           -> Promise<void>
 */
function createBlindPeeringClient({
  swarm,
  corestore,
  blindPeerKey,
  enabled,
  BlindPeeringClass,
  logger
} = {}) {
  const log = normalizeLogger(logger)
  const effectiveEnabled = (typeof enabled === 'boolean') ? enabled : blindPeeringFlagEnabled()
  const effectiveKey = (typeof blindPeerKey === 'string' && blindPeerKey.length > 0)
    ? blindPeerKey.trim()
    : getBlindPeerKey()

  const state = {
    enabled: !!effectiveEnabled,
    key: effectiveKey || '',
    active: false,           // BlindPeering instance actually constructed
    registrations: new Map(), // discoveryKeyHex -> { base, attempts: [ts,...], addedAt }
    lastError: null,
    closed: false
  }

  // Feature no-op branch: flag off OR key empty.
  if (!state.enabled) {
    log.info('blind-peering disabled (flag off)')
    return makeNoop(state, { reason: 'flag-off' })
  }
  if (!state.key) {
    log.warn('blind-peering flag enabled but CURVA_BLIND_PEER_KEY unset; no-op')
    return makeNoop(state, { reason: 'no-key' })
  }
  if (!swarm || !swarm.dht) {
    log.warn('blind-peering requires swarm.dht; disabling')
    return makeNoop(state, { reason: 'no-swarm' })
  }
  if (!corestore) {
    log.warn('blind-peering requires corestore; disabling')
    return makeNoop(state, { reason: 'no-corestore' })
  }

  let bp = null
  try {
    const Klass = BlindPeeringClass || loadBlindPeeringClass()
    bp = new Klass(swarm.dht, corestore, { keys: [state.key] })
    state.active = true
    log.info('blind-peering client active', { peerKeyShort: shortKey(state.key) })
  } catch (err) {
    state.lastError = err?.message || String(err)
    log.error('blind-peering init failed', { message: state.lastError })
    return makeNoop(state, { reason: 'init-failed', error: state.lastError })
  }

  // Code review fix (High): evict rate-limit entries that have been idle for
  // longer than the eviction TTL. Prevents unbounded growth of
  // state.registrations across a long session that opens/closes many bases.
  const RATE_LIMIT_EVICT_TTL_MS = 10 * 60 * 1000 // 10 min
  const RATE_LIMIT_MAX_ENTRIES = 512

  function ratelimitOk(baseKey) {
    const now = Date.now()
    let entry = state.registrations.get(baseKey)
    if (!entry) {
      entry = { attempts: [], addedAt: now }
      state.registrations.set(baseKey, entry)
    } else {
      entry.addedAt = entry.addedAt || now
    }
    // Trim attempts outside the rate-limit window.
    entry.attempts = entry.attempts.filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
    // Opportunistic eviction: whenever we touch the map, drop other entries
    // whose most recent attempt is older than the eviction TTL. Cheap because
    // it only iterates when we cross the max-entries threshold.
    if (state.registrations.size > RATE_LIMIT_MAX_ENTRIES) {
      for (const [k, e] of state.registrations) {
        if (k === baseKey) continue
        const lastAttempt = e.attempts.length > 0 ? e.attempts[e.attempts.length - 1] : (e.addedAt || 0)
        if (now - lastAttempt > RATE_LIMIT_EVICT_TTL_MS) {
          state.registrations.delete(k)
        }
      }
    }
    if (entry.attempts.length >= RATE_LIMIT_MAX) return { ok: false, entry }
    entry.attempts.push(now)
    return { ok: true, entry }
  }

  async function registerAutobase(base, extra = {}) {
    if (state.closed) return { ok: false, reason: 'closed' }
    if (!base) return { ok: false, reason: 'no-base' }
    let discoveryKeyHex = null
    try {
      // Autobase 7.x: `base.discoveryKey` exposes the write-side discovery key.
      // Fall back to the wakeupCapability key for older shapes.
      const dk = base.discoveryKey || base.wakeupCapability?.discoveryKey || base.key
      if (!dk) return { ok: false, reason: 'no-discovery-key' }
      discoveryKeyHex = b4a.isBuffer(dk) ? b4a.toString(dk, 'hex') : String(dk)
    } catch (err) {
      return { ok: false, reason: 'discovery-key-read-failed:' + (err?.message || 'unknown') }
    }

    const rl = ratelimitOk(discoveryKeyHex)
    if (!rl.ok) {
      log.warn('blind-peering rate limited', {
        discoveryKey: shortKey(discoveryKeyHex),
        window: RATE_LIMIT_WINDOW_MS,
        max: RATE_LIMIT_MAX
      })
      return { ok: false, reason: 'rate-limited' }
    }

    try {
      // ADR-003: pass an EXPLICIT per-base target so we do not rely on the
      // blind-peering default. Docs-native default is
      // `auto.wakeupCapability.key` (see node_modules/blind-peering/index.js:145);
      // we set the same value explicitly so an autobase whose shape drifts in
      // a future package version still gets the correct target instead of
      // silently registering under `undefined`. Callers may override via
      // `extra.target`.
      const explicitTarget = extra.target
        || base.wakeupCapability?.key
        || base.discoveryKey
        || base.key
      const forwarded = { ...extra, target: explicitTarget }
      log.info('blind-peering registerAutobase', {
        discoveryKey: shortKey(discoveryKeyHex),
        targetShort: shortKey(b4a.isBuffer(explicitTarget)
          ? b4a.toString(explicitTarget, 'hex')
          : String(explicitTarget || ''))
      })
      await bp.addAutobase(base, forwarded)
      rl.entry.base = base
      rl.entry.addedAt = Date.now()
      log.info('blind-peering registered autobase', {
        discoveryKey: shortKey(discoveryKeyHex)
      })
      return { ok: true, discoveryKey: discoveryKeyHex }
    } catch (err) {
      state.lastError = err?.message || String(err)
      log.warn('blind-peering register failed', {
        discoveryKey: shortKey(discoveryKeyHex),
        message: state.lastError
      })
      return { ok: false, reason: 'register-failed:' + state.lastError }
    }
  }

  /**
   * ADR-003: register a raw Hypercore with the blind peer. Some Curva
   * subsystems (clip index, tactical drawings) live outside Autobase; this
   * gives them the same seeding guarantee. Target defaults to `core.key`
   * exactly (documented default per node_modules/blind-peering/index.js:198).
   */
  async function registerCore(core, extra = {}) {
    if (state.closed) return { ok: false, reason: 'closed' }
    if (!core) return { ok: false, reason: 'no-core' }
    let coreKeyHex = null
    try {
      const k = core.key
      if (!k) return { ok: false, reason: 'no-core-key' }
      coreKeyHex = b4a.isBuffer(k) ? b4a.toString(k, 'hex') : String(k)
    } catch (err) {
      return { ok: false, reason: 'core-key-read-failed:' + (err?.message || 'unknown') }
    }
    const rl = ratelimitOk(coreKeyHex)
    if (!rl.ok) {
      log.warn('blind-peering rate limited (core)', {
        coreKey: shortKey(coreKeyHex),
        window: RATE_LIMIT_WINDOW_MS,
        max: RATE_LIMIT_MAX
      })
      return { ok: false, reason: 'rate-limited' }
    }
    try {
      const explicitTarget = extra.target || core.key
      const forwarded = { ...extra, target: explicitTarget }
      log.info('blind-peering registerCore', {
        coreKey: shortKey(coreKeyHex),
        targetShort: shortKey(b4a.isBuffer(explicitTarget)
          ? b4a.toString(explicitTarget, 'hex')
          : String(explicitTarget || ''))
      })
      await bp.addCore(core, forwarded)
      rl.entry.core = core
      rl.entry.addedAt = Date.now()
      return { ok: true, coreKey: coreKeyHex }
    } catch (err) {
      state.lastError = err?.message || String(err)
      log.warn('blind-peering registerCore failed', {
        coreKey: shortKey(coreKeyHex),
        message: state.lastError
      })
      return { ok: false, reason: 'register-failed:' + state.lastError }
    }
  }

  async function unregisterAutobase(base) {
    if (state.closed) return { ok: false, reason: 'closed' }
    if (!base) return { ok: false, reason: 'no-base' }
    let discoveryKeyHex = null
    try {
      const dk = base.discoveryKey || base.wakeupCapability?.discoveryKey || base.key
      if (!dk) return { ok: false, reason: 'no-discovery-key' }
      discoveryKeyHex = b4a.isBuffer(dk) ? b4a.toString(dk, 'hex') : String(dk)
    } catch (err) {
      return { ok: false, reason: 'discovery-key-read-failed:' + (err?.message || 'unknown') }
    }
    // The blind-peering client itself does not expose a per-autobase remove
    // method (registration is soft; the blind peer garbage-collects idle cores
    // per its own gcWait). We simply drop the entry from our bookkeeping so a
    // fresh registerAutobase() will retry cleanly.
    state.registrations.delete(discoveryKeyHex)
    log.info('blind-peering unregister (local bookkeeping only)', {
      discoveryKey: shortKey(discoveryKeyHex)
    })
    return { ok: true }
  }

  function status() {
    return {
      enabled: !!state.enabled,
      active: !!state.active,
      peerKeyShort: state.key ? shortKey(state.key) : null,
      registrationsCount: state.registrations.size,
      lastError: state.lastError
    }
  }

  /**
   * ADR-003: expose suspend/resume so the workers/main.js Pear teardown path
   * can quiesce the DHT sockets before we close them. Also lets a background-
   * mode Pear runtime free peer connections without tearing down bookkeeping.
   * The docs and installed source (node_modules/blind-peering/index.js:82,93)
   * confirm these are top-level BlindPeering methods, not per-peer.
   */
  async function suspend() {
    if (state.closed) return
    try {
      if (bp && typeof bp.suspend === 'function') await bp.suspend()
      log.info('blind-peering suspended')
    } catch (err) {
      log.warn('blind-peering suspend failed', { message: err?.message })
    }
  }
  async function resume() {
    if (state.closed) return
    try {
      if (bp && typeof bp.resume === 'function') await bp.resume()
      log.info('blind-peering resumed')
    } catch (err) {
      log.warn('blind-peering resume failed', { message: err?.message })
    }
  }

  async function close() {
    if (state.closed) return
    state.closed = true
    // ADR-003: quiesce BEFORE close so open peer sockets are torn down cleanly
    // (per the installed source: suspend() drops the DHT sockets, close()
    // then gc's the peer table).
    try {
      if (bp && typeof bp.suspend === 'function') await bp.suspend()
    } catch (err) {
      log.warn('blind-peering pre-close suspend failed', { message: err?.message })
    }
    try {
      if (bp) await bp.close()
    } catch (err) {
      log.warn('blind-peering close failed', { message: err?.message })
    }
    state.registrations.clear()
    state.active = false
  }

  return { registerAutobase, unregisterAutobase, registerCore, suspend, resume, status, close }
}

function makeNoop(state, { reason }) {
  const status = () => ({
    enabled: !!state.enabled,
    active: false,
    peerKeyShort: state.key ? shortKey(state.key) : null,
    registrationsCount: 0,
    lastError: state.lastError,
    reason
  })
  return {
    async registerAutobase() { return { ok: false, reason } },
    async unregisterAutobase() { return { ok: true } },
    async registerCore() { return { ok: false, reason } },
    async suspend() {},
    async resume() {},
    status,
    async close() {}
  }
}

function normalizeLogger(logger) {
  const noop = () => {}
  if (!logger) return { info: noop, warn: noop, error: noop }
  return {
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : noop,
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : noop,
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : noop
  }
}

function shortKey(k) {
  if (typeof k !== 'string' || k.length === 0) return ''
  if (k.length <= 12) return k
  return k.slice(0, 8) + '…' + k.slice(-4)
}

module.exports = {
  createBlindPeeringClient,
  getBlindPeerKey,
  blindPeeringFlagEnabled,
  // exported for tests / instrumentation
  _internal: {
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
    BLIND_PEER_KEY_ENV,
    shortKey
  }
}
