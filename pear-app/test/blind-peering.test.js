// Wave 15 tests for bare/blindPeering.js
//
// Coverage:
//   - Feature flag off -> registerAutobase is a no-op (returns { ok:false, reason:'flag-off' })
//   - Missing CURVA_BLIND_PEER_KEY -> feature no-ops with reason 'no-key'
//   - Register + unregister lifecycle works against a fake BlindPeering
//   - Rate limit hits at the 6th registration attempt in a minute
//   - Room close (via unregister) is idempotent + cleans local bookkeeping
//   - Non-host peer path: registration still fires (feature is not host-only)
//   - close() calls the underlying BlindPeering.close()

const test = require('brittle')
const {
  createBlindPeeringClient,
  getBlindPeerKey,
  blindPeeringFlagEnabled,
  _internal
} = require('../bare/blindPeering.js')

// ---- fakes ------------------------------------------------------------------

function makeFakeBlindPeeringClass({ throwOnConstruct = false, throwOnAdd = false } = {}) {
  const calls = { construct: [], addAutobase: [], close: 0 }
  class FakeBlindPeering {
    constructor(dht, store, opts) {
      calls.construct.push({ dht, store, opts })
      if (throwOnConstruct) throw new Error('boom-construct')
      this.dht = dht
      this.store = store
      this.opts = opts
      this.closed = false
    }
    async addAutobase(auto, extra) {
      calls.addAutobase.push({ auto, extra })
      if (throwOnAdd) throw new Error('boom-add')
    }
    async close() {
      this.closed = true
      calls.close++
    }
  }
  return { FakeBlindPeering, calls }
}

function makeFakeSwarm() {
  return { dht: { on() {}, off() {} } }
}
function makeFakeStore() {
  return { namespace() { return {} } }
}
function makeFakeAutobase(discoveryHex) {
  // b4a-compatible discovery key buffer
  const buf = Buffer.from(discoveryHex, 'hex')
  return { discoveryKey: buf }
}

// ---- env helpers ------------------------------------------------------------

function withEnv(patch, fn) {
  const prev = {}
  for (const k of Object.keys(patch)) {
    prev[k] = process.env[k]
    if (patch[k] === undefined) delete process.env[k]
    else process.env[k] = patch[k]
  }
  try { return fn() } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

// ---- tests ------------------------------------------------------------------

test('env helpers: flag off and empty key by default', async (t) => {
  await withEnv({ CURVA_BLIND_PEERING_ENABLED: undefined, CURVA_BLIND_PEER_KEY: undefined }, () => {
    t.is(blindPeeringFlagEnabled(), false)
    t.is(getBlindPeerKey(), '')
  })
})

test('env helpers: flag on with key', async (t) => {
  await withEnv({
    CURVA_BLIND_PEERING_ENABLED: 'true',
    CURVA_BLIND_PEER_KEY: 'z' + 'a'.repeat(51)
  }, () => {
    t.is(blindPeeringFlagEnabled(), true)
    t.is(getBlindPeerKey().length, 52)
  })
})

test('feature flag off -> registerAutobase is a no-op', async (t) => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    blindPeerKey: 'z' + 'k'.repeat(51),
    enabled: false, // explicit override
    BlindPeeringClass: FakeBlindPeering
  })
  const base = makeFakeAutobase('aa'.repeat(32))
  const res = await client.registerAutobase(base)
  t.is(res.ok, false)
  t.is(res.reason, 'flag-off')
  t.is(calls.construct.length, 0, 'no BlindPeering constructed when flag off')
  t.is(client.status().enabled, false)
  await client.close()
})

test('missing blind_peer_key -> feature no-ops with reason no-key', async (t) => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: '',
    BlindPeeringClass: FakeBlindPeering
  })
  const base = makeFakeAutobase('bb'.repeat(32))
  const res = await client.registerAutobase(base)
  t.is(res.ok, false)
  t.is(res.reason, 'no-key')
  t.is(calls.construct.length, 0)
  const st = client.status()
  t.is(st.enabled, true)
  t.is(st.active, false)
  t.is(st.reason, 'no-key')
  await client.close()
})

test('register + unregister lifecycle works against fake BlindPeering', async (t) => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: 'z' + 'a'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  t.is(calls.construct.length, 1, 'constructor called once at init')
  t.is(client.status().active, true)

  const base = makeFakeAutobase('cc'.repeat(32))
  const res = await client.registerAutobase(base)
  t.is(res.ok, true)
  t.is(res.discoveryKey, 'cc'.repeat(32))
  t.is(calls.addAutobase.length, 1)
  t.is(client.status().registrationsCount, 1)

  const un = await client.unregisterAutobase(base)
  t.is(un.ok, true)
  t.is(client.status().registrationsCount, 0)
  await client.close()
  t.is(calls.close, 1, 'BlindPeering.close was called')
})

test('rate limit: 6th registration attempt inside window fails', async (t) => {
  const { FakeBlindPeering } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: 'z' + 'a'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  const base = makeFakeAutobase('dd'.repeat(32))
  for (let i = 0; i < _internal.RATE_LIMIT_MAX; i++) {
    const res = await client.registerAutobase(base)
    t.is(res.ok, true, 'attempt ' + (i + 1) + ' allowed')
  }
  const overflow = await client.registerAutobase(base)
  t.is(overflow.ok, false)
  t.is(overflow.reason, 'rate-limited')
  await client.close()
})

test('room close is idempotent and clears bookkeeping', async (t) => {
  const { FakeBlindPeering } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: 'z' + 'a'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  const base = makeFakeAutobase('ee'.repeat(32))
  await client.registerAutobase(base)
  const first = await client.unregisterAutobase(base)
  const second = await client.unregisterAutobase(base)
  t.is(first.ok, true)
  t.is(second.ok, true, 'second unregister still returns ok (idempotent)')
  t.is(client.status().registrationsCount, 0)
  await client.close()
})

test('non-host peer path: registration still fires (feature is not host-only)', async (t) => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: 'z' + 'p'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  const base = makeFakeAutobase('11'.repeat(32))
  const res = await client.registerAutobase(base)
  t.is(res.ok, true)
  t.is(calls.addAutobase.length, 1, 'peer role (non-host) also registers')
  await client.close()
})

test('constructor throw is caught and yields safe no-op client', async (t) => {
  const { FakeBlindPeering } = makeFakeBlindPeeringClass({ throwOnConstruct: true })
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: 'z' + 'k'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  const base = makeFakeAutobase('22'.repeat(32))
  const res = await client.registerAutobase(base)
  t.is(res.ok, false)
  t.is(res.reason, 'init-failed')
  const st = client.status()
  t.is(st.active, false)
  t.ok(st.lastError && st.lastError.length > 0)
  await client.close()
})

test('addAutobase failure is captured in lastError', async (t) => {
  const { FakeBlindPeering } = makeFakeBlindPeeringClass({ throwOnAdd: true })
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: 'z' + 'k'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  const base = makeFakeAutobase('33'.repeat(32))
  const res = await client.registerAutobase(base)
  t.is(res.ok, false)
  t.ok(res.reason.startsWith('register-failed:'), 'reason mentions register-failed')
  t.ok(client.status().lastError && client.status().lastError.length > 0)
  await client.close()
})

test('shortKey helper trims long pubkeys and keeps short ones intact', (t) => {
  t.is(_internal.shortKey(''), '')
  t.is(_internal.shortKey('abcdef'), 'abcdef')
  const long = 'z' + 'a'.repeat(51)
  const short = _internal.shortKey(long)
  t.ok(short.includes('…'))
  t.is(short.length, 13)
})
