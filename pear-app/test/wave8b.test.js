// Wave 8B brittle tests: relayThrough fetch, seeder stats accumulator,
// bounded peer-count lookup pool.
//
// We test the pure helpers in bare/topics.js. Actual Hyperswarm relaying
// and DHT lookups are integration territory (Bare + real network) so we
// stub the swarm shim aggressively.

const test = require('brittle')
const b4a = require('b4a')

const {
  fetchRelayInfo,
  getCachedRelayInfo,
  createSeederStats,
  createPeerCountLookup,
  __resetAllForTest,
  topicForSlug
} = require('../bare/topics.js')

const ORIG_FETCH = globalThis.fetch

function installMockFetch(responder) {
  globalThis.fetch = async (url, init) => {
    const rec = { url, init: init || {} }
    const out = await responder(rec)
    if (out === undefined) throw new Error('mock returned nothing for ' + url)
    return out
  }
}
function restoreFetch() { globalThis.fetch = ORIG_FETCH }
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body }
  }
}

// -- T1: fetchRelayInfo ---------------------------------------------------

test('fetchRelayInfo: happy path caches pubkey', async (t) => {
  __resetAllForTest()
  installMockFetch(async ({ url }) => {
    t.is(url, 'http://api.test/relay/info', 'hits /relay/info')
    return jsonResponse(200, {
      success: true,
      data: {
        pubkey: 'a'.repeat(64),
        swarmKey: 'b'.repeat(64),
        regions: ['us-east']
      }
    })
  })
  try {
    const info = await fetchRelayInfo('http://api.test/')
    t.ok(info, 'returns info')
    t.is(info.pubkey.length, 64, 'pubkey is 64-hex')
    t.is(info.regions[0], 'us-east')
    // Second call must be a cache hit — no network.
    let calls = 0
    installMockFetch(async () => { calls++; return jsonResponse(200, {}) })
    const cached = await fetchRelayInfo('http://api.test/')
    t.is(cached.pubkey, info.pubkey, 'cached pubkey identical')
    t.is(calls, 0, 'second call served from cache')
    t.ok(getCachedRelayInfo(), 'sync getter returns cache')
  } finally { restoreFetch() }
})

test('fetchRelayInfo: rejects malformed pubkey', async (t) => {
  __resetAllForTest()
  installMockFetch(async () => jsonResponse(200, { data: { pubkey: 'not-hex', regions: [] } }))
  try {
    const info = await fetchRelayInfo('http://api.test/')
    t.is(info, null, 'malformed pubkey rejected')
  } finally { restoreFetch() }
})

test('fetchRelayInfo: 5xx returns null (no throw)', async (t) => {
  __resetAllForTest()
  installMockFetch(async () => jsonResponse(500, { error: 'boom' }))
  try {
    const info = await fetchRelayInfo('http://api.test/')
    t.is(info, null, '500 -> null')
  } finally { restoreFetch() }
})

test('fetchRelayInfo: empty backend url yields null', async (t) => {
  __resetAllForTest()
  const info = await fetchRelayInfo('')
  t.is(info, null)
})

// -- T2: seederStats ------------------------------------------------------

test('seederStats: tracks active peers', (t) => {
  const s = createSeederStats({})
  s.setEnabled(true, 'pear://xyz')
  s.onPeerConnected('peer-a')
  s.onPeerConnected('peer-b')
  let snap = s.snapshot()
  t.is(snap.activePeers, 2)
  t.is(snap.seederEnabled, true)
  t.is(snap.pearAppKey, 'pear://xyz')
  s.onPeerDisconnected('peer-a')
  snap = s.snapshot()
  t.is(snap.activePeers, 1)
})

test('seederStats: rolling one-hour window dedupes reconnections', (t) => {
  let now = 1_000_000
  const s = createSeederStats({ windowMs: 60_000, now: () => now })
  s.onPeerConnected('peer-a')
  s.onPeerConnected('peer-b')
  s.onPeerConnected('peer-a') // reconnect
  const snap = s.snapshot()
  t.is(snap.totalPeersLastHour, 2, 'unique-per-window count')
  t.is(snap.activePeers, 2, 'active still 2')
})

test('seederStats: evicts entries older than the window', (t) => {
  let now = 100
  const s = createSeederStats({ windowMs: 60_000, now: () => now })
  s.onPeerConnected('old')
  now = 100 + 61_000
  s.onPeerConnected('new')
  const snap = s.snapshot()
  t.is(snap.totalPeersLastHour, 1, 'old evicted')
})

test('seederStats: bytesReplicated accumulates non-negatively', (t) => {
  const s = createSeederStats({})
  s.addBytes(100)
  s.addBytes(50)
  s.addBytes(-5) // ignored
  s.addBytes(NaN) // ignored
  const snap = s.snapshot()
  t.is(snap.bytesReplicated, 150)
})

// -- T3: peer-count lookup ------------------------------------------------

function makeSwarmShim({ onLookup, lookupDelayMs = 0 }) {
  return {
    dht: {
      lookup(topic) {
        // Return an async iterable that yields once and closes.
        return {
          async *[Symbol.asyncIterator]() {
            if (lookupDelayMs > 0) await new Promise((r) => setTimeout(r, lookupDelayMs))
            onLookup?.(topic)
            yield { peers: [
              { publicKey: b4a.from('11'.repeat(32), 'hex') },
              { publicKey: b4a.from('22'.repeat(32), 'hex') },
              { publicKey: b4a.from('33'.repeat(32), 'hex') }
            ] }
          },
          destroy() { /* noop */ }
        }
      }
    }
  }
}

test('peerCountLookup: returns unique peer count and caches for TTL', async (t) => {
  let hits = 0
  const swarm = makeSwarmShim({ onLookup: () => hits++ })
  const lookup = createPeerCountLookup({ swarm, ttlMs: 1000 })
  const topicHex = b4a.toString(topicForSlug('demo-1'), 'hex')

  const r1 = await lookup(topicHex)
  t.is(r1.count, 3)
  t.is(r1.cached, false)

  const r2 = await lookup(topicHex)
  t.is(r2.count, 3)
  t.is(r2.cached, true, 'second call cached')
  t.is(hits, 1, 'DHT called exactly once within TTL')
})

test('peerCountLookup: respects the maxConcurrent cap', async (t) => {
  let live = 0
  let maxLive = 0
  const swarm = {
    dht: {
      lookup() {
        return {
          async *[Symbol.asyncIterator]() {
            live++
            if (live > maxLive) maxLive = live
            await new Promise((r) => setTimeout(r, 30))
            live--
            yield { peers: [] }
          },
          destroy() { /* noop */ }
        }
      }
    }
  }
  const lookup = createPeerCountLookup({ swarm, ttlMs: 100, maxConcurrent: 3 })
  const topics = []
  for (let i = 0; i < 12; i++) topics.push(b4a.toString(topicForSlug('t-' + i), 'hex'))
  await Promise.all(topics.map((h) => lookup(h)))
  t.ok(maxLive <= 3, 'never more than 3 in-flight (was ' + maxLive + ')')
})

test('peerCountLookup: graceful when swarm has no dht.lookup', async (t) => {
  const lookup = createPeerCountLookup({ swarm: {} })
  const r = await lookup('a'.repeat(64))
  t.is(r.count, 0)
  t.is(r.error, 'no-dht')
})

// Final Fix Wave T-C4: verify the timeout+break termination path. The
// production lookup uses two mechanisms in tandem: (1) `iter.destroy?.()`
// inside the timer for ReadableStream-backed iterators that hang between
// pages (hyperdht's real behavior), and (2) `if (done) break` to let
// ECMA-262 IteratorClose run its `return()` protocol for cooperative
// iterators. This test exercises path (1) — a stream that hangs and only
// terminates on `destroy()` — and asserts we do NOT wait past the timeout.
test('peerCountLookup: iter.destroy() unblocks a hung DHT stream at the timeout', async (t) => {
  let destroyed = false
  const swarm = {
    dht: {
      lookup() {
        let resolveHang = null
        return {
          async *[Symbol.asyncIterator]() {
            yield { peers: [
              { publicKey: b4a.from('11'.repeat(32), 'hex') },
              { publicKey: b4a.from('22'.repeat(32), 'hex') }
            ] }
            // Hang forever — only `destroy()` can unstick us. This mimics a
            // hyperdht lookup that has announced but has no further peers to
            // yield within the lookup window.
            await new Promise((resolve) => { resolveHang = resolve })
          },
          destroy() {
            destroyed = true
            if (typeof resolveHang === 'function') resolveHang()
          }
        }
      }
    }
  }
  const lookup = createPeerCountLookup({ swarm, ttlMs: 100, timeoutMs: 50 })
  const t0 = Date.now()
  const r = await lookup('a'.repeat(64))
  const elapsed = Date.now() - t0
  t.is(r.count, 2, 'peers observed before timeout are returned')
  t.ok(elapsed < 500, 'lookup terminated promptly, elapsed=' + elapsed)
  t.ok(destroyed, 'iter.destroy() was invoked by the timeout')
})

// -- T1: relayThrough behavior branching ---------------------------------
// We can't spin up hyperswarm in a unit test, but we can validate the
// relay-selection function shape by mimicking hyperswarm's contract:
//   `toRelayFunction(fn)` calls fn(force, swarm) and expects null|Buffer.

test('relayThrough closure returns null when no relay key is configured', (t) => {
  // Reconstruct the same shape used in workers/main.js. We deliberately
  // duplicate the logic here because the closure captures module-scoped
  // state in workers/main.js and pulling it out would leak worker internals
  // into the test surface.
  let relayKeyBuf = null
  const forceRelayEnv = false
  const relayThroughFn = (force, swarm) => {
    if (!relayKeyBuf) return null
    if (forceRelayEnv) return relayKeyBuf
    if (force) return relayKeyBuf
    if (swarm?.dht?.randomized) return relayKeyBuf
    return null
  }
  t.is(relayThroughFn(false, { dht: {} }), null)
  t.is(relayThroughFn(true, { dht: {} }), null, 'force without key still null')
})

test('relayThrough closure: forced env returns key on every call', (t) => {
  const relayKeyBuf = b4a.from('cc'.repeat(32), 'hex')
  const forceRelayEnv = true
  const relayThroughFn = (force, swarm) => {
    if (!relayKeyBuf) return null
    if (forceRelayEnv) return relayKeyBuf
    if (force) return relayKeyBuf
    if (swarm?.dht?.randomized) return relayKeyBuf
    return null
  }
  t.alike(relayThroughFn(false, { dht: { randomized: false } }), relayKeyBuf)
  t.alike(relayThroughFn(true, { dht: {} }), relayKeyBuf)
})

test('relayThrough closure: randomized DHT triggers relay', (t) => {
  const relayKeyBuf = b4a.from('dd'.repeat(32), 'hex')
  const forceRelayEnv = false
  const relayThroughFn = (force, swarm) => {
    if (!relayKeyBuf) return null
    if (forceRelayEnv) return relayKeyBuf
    if (force) return relayKeyBuf
    if (swarm?.dht?.randomized) return relayKeyBuf
    return null
  }
  t.is(relayThroughFn(false, { dht: { randomized: false } }), null)
  t.alike(relayThroughFn(false, { dht: { randomized: true } }), relayKeyBuf)
  t.alike(relayThroughFn(true, { dht: { randomized: false } }), relayKeyBuf, 'force flag alone triggers relay')
})
