// Curva topic hashing - THE ONE canonical hash used everywhere.
//
// All peers in room `<slug>` MUST derive the swarm topic the same way, or they
// will not find each other. Do NOT duplicate this hashing logic elsewhere.
// Backend F6 (rooms directory) also derives topics with this exact scheme.
//
// Verified against hypercore-crypto@3.7.0 (data(): sha256 with 'hypercore data' salt).
//
// Wave 8B additions:
//  - fetchRelayInfo(): pulls the backend seeder pubkey (used as Hyperswarm
//    relayThrough target) once at cold start.
//  - createPeerCountLookup(): bounded DHT lookup pool for per-topic live
//    peer counts (RoomBrowser Phase 2 render).

const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const TOPIC_PREFIX = 'curva/'

// Task 8: cache of the current Curva pear:// distribution key. Fetched
// once at Bare worker cold start from GET /distribution/pear-link. Cached
// in module scope for the lifetime of the worker. `null` means "unknown"
// (either the backend is offline, F13 distribution is disabled, or we
// haven't yet asked); callers should fall back to a curva:// deep link.
let cachedPearKey = null
let fetchPromise = null

// Wave 8B T1: cached backend seeder relay info. Fetched once at boot from
// GET /relay/info. `null` means "no relay available" (backend down or F1
// disabled); callers must degrade gracefully — the swarm still works without
// a relay for peers on symmetric-friendly NATs.
let cachedRelayInfo = null
let relayFetchPromise = null

/**
 * Fetch the current pear:// distribution key from the backend and cache it.
 * Callable multiple times; only performs one network request in flight.
 * Never throws — returns null on any failure.
 *
 * @param {string} backendUrl
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string|null>}
 */
async function fetchPearAppKey(backendUrl, { timeoutMs = 5000 } = {}) {
  if (cachedPearKey) return cachedPearKey
  if (fetchPromise) return fetchPromise
  if (typeof fetch !== 'function') return null
  if (typeof backendUrl !== 'string' || backendUrl.length === 0) return null
  const base = backendUrl.replace(/\/+$/, '')
  const url = base + '/distribution/pear-link'

  fetchPromise = (async () => {
    let controller = null
    let timer = null
    try {
      if (typeof AbortController === 'function') {
        controller = new AbortController()
        timer = setTimeout(() => { try { controller.abort() } catch { /* noop */ } }, timeoutMs)
      }
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller?.signal
      })
      if (!resp.ok) {
        // 404 (distribution disabled) is expected; do not spam logs.
        return null
      }
      const json = await resp.json().catch(() => null)
      const key = json?.data?.pearLink || json?.pearLink || json?.data?.key || null
      if (typeof key === 'string' && key.startsWith('pear://') && !key.includes('<')) {
        cachedPearKey = key
        return cachedPearKey
      }
      return null
    } catch { return null }
    finally {
      if (timer) clearTimeout(timer)
    }
  })().finally(() => { fetchPromise = null })

  return fetchPromise
}

/**
 * Return the cached key (synchronous). Caller must have already awaited
 * fetchPearAppKey once; otherwise returns null.
 */
function getCachedPearAppKey() { return cachedPearKey }

/**
 * Reset the module cache. Used ONLY by tests.
 */
function __resetForTest() { cachedPearKey = null; fetchPromise = null }

/**
 * @param {string} slug room slug, ASCII, 1-64 chars
 * @returns {Buffer} 32-byte topic hash suitable for hyperswarm.join()
 */
function topicForSlug(slug) {
  if (typeof slug !== 'string') {
    throw new TypeError('slug must be a string')
  }
  if (slug.length === 0 || slug.length > 64) {
    throw new RangeError('slug must be 1-64 characters')
  }
  return crypto.data(b4a.from(TOPIC_PREFIX + slug))
}

/**
 * Wave 8B T1: Fetch backend seeder relay info once at Bare boot. Cached in
 * module scope. Never throws — returns null on failure so the swarm still
 * boots without a relay (peers on friendly NATs will connect directly).
 *
 * Backend contract (backend/src/routes/relayRoutes.ts):
 *   GET /relay/info -> { success, data: { pubkey, swarmKey, regions } }
 * `pubkey` is a hex-encoded 32-byte key we can pass as `relayThrough` to
 * Hyperswarm. The hex-string is converted to a Buffer by the caller (workers/main.js).
 *
 * @param {string} backendUrl
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ pubkey: string, swarmKey: string|null, regions: string[] }|null>}
 */
async function fetchRelayInfo(backendUrl, { timeoutMs = 5000 } = {}) {
  if (cachedRelayInfo) return cachedRelayInfo
  if (relayFetchPromise) return relayFetchPromise
  if (typeof fetch !== 'function') return null
  if (typeof backendUrl !== 'string' || backendUrl.length === 0) return null
  const base = backendUrl.replace(/\/+$/, '')
  const url = base + '/relay/info'

  relayFetchPromise = (async () => {
    let controller = null
    let timer = null
    try {
      if (typeof AbortController === 'function') {
        controller = new AbortController()
        timer = setTimeout(() => { try { controller.abort() } catch { /* noop */ } }, timeoutMs)
      }
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller?.signal
      })
      if (!resp.ok) return null
      const json = await resp.json().catch(() => null)
      const data = json?.data || json
      const pubkey = data?.pubkey
      if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) {
        return null
      }
      cachedRelayInfo = {
        pubkey,
        swarmKey: typeof data.swarmKey === 'string' ? data.swarmKey : null,
        regions: Array.isArray(data.regions) ? data.regions : []
      }
      return cachedRelayInfo
    } catch { return null }
    finally {
      if (timer) clearTimeout(timer)
    }
  })().finally(() => { relayFetchPromise = null })

  return relayFetchPromise
}

function getCachedRelayInfo() { return cachedRelayInfo }

/**
 * Extend __resetForTest to cover the relay cache too.
 */
function __resetAllForTest() {
  cachedPearKey = null
  fetchPromise = null
  cachedRelayInfo = null
  relayFetchPromise = null
}

/**
 * Wave 8B T3: bounded DHT peer-count lookup with caching.
 *
 * Rationale: hyperswarm exposes `swarm.dht.lookup(topic)` as an async iterable
 * yielding `data.peers[]` (verified at
 * node_modules/hyperswarm/lib/peer-discovery.js:118 and
 * node_modules/hyperdht/index.js:194). We wrap it with:
 *   - a 60s TTL cache per-topic (topic bytes hex-keyed)
 *   - a hard cap on concurrent lookups (default 10) so a 104-fixture browser
 *     screen never crushes the DHT
 *   - a per-lookup timeout so a stalled probe cannot block the queue forever
 *
 * The returned function takes a topic (Buffer or 32-byte-hex string) and
 * resolves to { count, cached, error?: string }. `count` is a lower bound —
 * the DHT may return more peers on repeat lookups.
 *
 * @param {{ swarm: object, ttlMs?: number, maxConcurrent?: number, timeoutMs?: number }} opts
 */
function createPeerCountLookup({
  swarm,
  ttlMs = 60_000,
  maxConcurrent = 10,
  timeoutMs = 4_000
} = {}) {
  if (!swarm || !swarm.dht || typeof swarm.dht.lookup !== 'function') {
    // Degrade to a no-op. Tests replace `swarm` with a shim.
    return async () => ({ count: 0, cached: false, error: 'no-dht' })
  }

  const cache = new Map() // topicHex -> { count, expiresAt }
  let inFlight = 0
  const waiters = []

  function acquire() {
    if (inFlight < maxConcurrent) {
      inFlight++
      return Promise.resolve()
    }
    return new Promise((resolve) => waiters.push(resolve))
  }
  function release() {
    inFlight--
    const next = waiters.shift()
    if (next) { inFlight++; next() }
  }

  function toHex(topic) {
    if (typeof topic === 'string') return topic.toLowerCase()
    return b4a.toString(topic, 'hex')
  }
  function toBuffer(topic) {
    if (typeof topic === 'string') return b4a.from(topic, 'hex')
    return topic
  }

  async function lookupOne(topic) {
    const hex = toHex(topic)
    const now = Date.now()
    const cached = cache.get(hex)
    if (cached && cached.expiresAt > now) {
      return { count: cached.count, cached: true }
    }
    await acquire()
    let done = false
    try {
      const seen = new Set()
      const buf = toBuffer(topic)
      const iter = swarm.dht.lookup(buf)
      // Two termination mechanisms belt-and-braces:
      //  1. `iter.destroy?.()` inside the timer — hyperdht's lookup returns a
      //     ReadableStream-backed async iterator that will otherwise wait
      //     indefinitely for the DHT to yield the next page. `destroy` is the
      //     stream API that forcibly closes it, which unblocks our loop.
      //  2. The `break` on `done` inside the loop — for iterators that DO
      //     honor cooperative cancellation, this lets the async-iterator
      //     `return()` protocol (ECMA-262 IteratorClose) run instead of a
      //     hard destroy. Some non-stream iterators lack `destroy`, so the
      //     optional chain no-ops and this branch handles the exit.
      // Spec: https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-asynciterator-interface
      const timer = setTimeout(() => {
        done = true
        try { iter.destroy?.() } catch { /* noop */ }
      }, timeoutMs)
      try {
        for await (const data of iter) {
          if (done) break
          const peers = data?.peers || []
          for (const p of peers) {
            if (!p?.publicKey) continue
            seen.add(b4a.toString(p.publicKey, 'hex'))
          }
        }
      } catch { /* iterator terminated / aborted */ }
      finally { clearTimeout(timer) }
      const count = seen.size
      cache.set(hex, { count, expiresAt: Date.now() + ttlMs })
      return { count, cached: false }
    } catch (err) {
      return { count: 0, cached: false, error: err?.message || 'lookup failed' }
    } finally {
      release()
    }
  }

  function __getStats() {
    return { inFlight, waiting: waiters.length, cacheSize: cache.size }
  }
  function __clear() { cache.clear() }

  return Object.assign(lookupOne, { __getStats, __clear })
}

/**
 * Wave 8B T2: in-process seeder stats accumulator. Tracks live peer count on a
 * dedicated namespace + a rolling one-hour window + a byte counter.
 *
 * The accumulator is INTENTIONALLY decoupled from the swarm — the caller
 * feeds it events (onPeerConnected, onPeerDisconnected, onBytesReplicated)
 * so we can unit-test the math without mocking Hyperswarm.
 */
function createSeederStats({ windowMs = 60 * 60 * 1000, now = Date.now } = {}) {
  const activePeers = new Map() // peerKey -> connectedAt
  const recentPeers = [] // { peerKey, at } — deduped rolling window
  let bytesReplicated = 0
  let seederEnabled = false
  let pearAppKey = null

  function evictOld(t) {
    while (recentPeers.length && (t - recentPeers[0].at) > windowMs) {
      recentPeers.shift()
    }
  }

  function onPeerConnected(peerKey) {
    if (typeof peerKey !== 'string' || peerKey.length === 0) return
    const t = now()
    activePeers.set(peerKey, t)
    // Dedupe: replace prior entry for same key so hour-window is per-unique-peer.
    for (let i = recentPeers.length - 1; i >= 0; i--) {
      if (recentPeers[i].peerKey === peerKey) { recentPeers.splice(i, 1); break }
    }
    recentPeers.push({ peerKey, at: t })
    evictOld(t)
  }
  function onPeerDisconnected(peerKey) {
    if (typeof peerKey !== 'string') return
    activePeers.delete(peerKey)
  }
  function addBytes(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return
    bytesReplicated += n
  }
  function setEnabled(v, key) {
    seederEnabled = !!v
    if (typeof key === 'string' && key.length > 0) pearAppKey = key
  }

  function snapshot() {
    evictOld(now())
    return {
      activePeers: activePeers.size,
      totalPeersLastHour: recentPeers.length,
      bytesReplicated,
      seederEnabled,
      pearAppKey
    }
  }

  return {
    onPeerConnected,
    onPeerDisconnected,
    addBytes,
    setEnabled,
    snapshot,
    // test-only introspection
    __state: () => ({ activePeers: [...activePeers], recentPeers: [...recentPeers], bytesReplicated, seederEnabled, pearAppKey })
  }
}

module.exports = {
  topicForSlug,
  TOPIC_PREFIX,
  fetchPearAppKey,
  getCachedPearAppKey,
  fetchRelayInfo,
  getCachedRelayInfo,
  createPeerCountLookup,
  createSeederStats,
  __resetForTest,
  __resetAllForTest
}
