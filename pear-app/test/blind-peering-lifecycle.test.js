// ADR-003 lifecycle test: blind-peering per-core target + suspend/resume order.
//
// The Curva blind-peering wrapper (bare/blindPeering.js) must:
//   1. Pass an EXPLICIT target on addAutobase / addCore so a future package
//      version's shape drift does not silently register under `undefined`.
//      Verified: node_modules/blind-peering/index.js:145 defaults to
//      `auto.wakeupCapability.key`; we set the same value explicitly.
//   2. Expose suspend() and resume() that delegate to the underlying peering
//      instance. Verified: node_modules/blind-peering/index.js:82,93 —
//      top-level BlindPeering.suspend()/resume() are the DHT-quiesce hooks.
//   3. close() must suspend() BEFORE it closes so peer sockets are torn down
//      cleanly. Assert that suspend is called at least once before close.

const test = require('brittle')
const {
  createBlindPeeringClient,
  _internal
} = require('../bare/blindPeering.js')

function makeFakeBlindPeeringClass() {
  const calls = {
    construct: [],
    addAutobase: [],
    addCore: [],
    suspend: 0,
    resume: 0,
    close: 0,
    order: []
  }
  class FakeBlindPeering {
    constructor(dht, store, opts) {
      calls.construct.push({ dht, store, opts })
      this.dht = dht
      this.store = store
      this.opts = opts
    }
    async addAutobase(auto, extra) {
      calls.addAutobase.push({ auto, extra })
      calls.order.push('addAutobase')
    }
    async addCore(core, extra) {
      calls.addCore.push({ core, extra })
      calls.order.push('addCore')
    }
    async suspend() {
      calls.suspend++
      calls.order.push('suspend')
    }
    async resume() {
      calls.resume++
      calls.order.push('resume')
    }
    async close() {
      calls.close++
      calls.order.push('close')
    }
  }
  return { FakeBlindPeering, calls }
}

function makeFakeSwarm() { return { dht: {} } }
function makeFakeStore() { return { namespace() { return {} } } }

function makeFakeAutobase(discoveryHex, { wakeupHex } = {}) {
  const dk = Buffer.from(discoveryHex, 'hex')
  const wakeup = wakeupHex
    ? { key: Buffer.from(wakeupHex, 'hex') }
    : { key: dk }
  return { discoveryKey: dk, wakeupCapability: wakeup, key: dk }
}

function makeFakeCore(keyHex) {
  return { key: Buffer.from(keyHex, 'hex') }
}

test('ADR-003: registerAutobase sets an EXPLICIT target derived from wakeupCapability.key', async (t) => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: 'z' + 'a'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  const wakeupHex = 'ee'.repeat(32)
  const base = makeFakeAutobase('aa'.repeat(32), { wakeupHex })
  const res = await client.registerAutobase(base)
  t.is(res.ok, true)
  t.is(calls.addAutobase.length, 1)
  const passed = calls.addAutobase[0].extra
  t.ok(passed && passed.target, 'target field is passed through explicitly')
  const targetHex = Buffer.from(passed.target).toString('hex')
  t.is(targetHex, wakeupHex, 'target matches wakeupCapability.key when present')
  await client.close()
})

test('ADR-003: registerAutobase falls back to discoveryKey when wakeupCapability is absent', async (t) => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: 'z' + 'a'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  // Autobase without wakeupCapability.
  const base = { discoveryKey: Buffer.from('bb'.repeat(32), 'hex') }
  const res = await client.registerAutobase(base)
  t.is(res.ok, true)
  const passed = calls.addAutobase[0].extra
  t.ok(passed.target, 'target set even without wakeupCapability')
  t.is(Buffer.from(passed.target).toString('hex'), 'bb'.repeat(32),
    'target falls back to discoveryKey')
  await client.close()
})

test('ADR-003: caller-supplied target wins over the default', async (t) => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: 'z' + 'a'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  const base = makeFakeAutobase('cc'.repeat(32))
  const overrideTarget = Buffer.from('11'.repeat(32), 'hex')
  await client.registerAutobase(base, { target: overrideTarget })
  const passed = calls.addAutobase[0].extra
  t.is(Buffer.from(passed.target).toString('hex'), '11'.repeat(32),
    'caller override is honored')
  await client.close()
})

test('ADR-003: registerCore sets target to core.key by default', async (t) => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: 'z' + 'a'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  const core = makeFakeCore('dd'.repeat(32))
  const res = await client.registerCore(core)
  t.is(res.ok, true)
  t.is(calls.addCore.length, 1)
  const passed = calls.addCore[0].extra
  t.is(Buffer.from(passed.target).toString('hex'), 'dd'.repeat(32),
    'core target defaults to core.key hex')
  await client.close()
})

test('ADR-003: suspend + resume delegate to the underlying BlindPeering', async (t) => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: 'z' + 'a'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  const base = makeFakeAutobase('ee'.repeat(32))
  await client.registerAutobase(base)
  await client.suspend()
  await client.resume()
  t.is(calls.suspend, 1, 'suspend was delegated exactly once')
  t.is(calls.resume, 1, 'resume was delegated exactly once')
  // Order sanity: addAutobase came before suspend, and resume came after
  // suspend.
  const iAdd = calls.order.indexOf('addAutobase')
  const iSusp = calls.order.indexOf('suspend')
  const iRes = calls.order.indexOf('resume')
  t.ok(iAdd < iSusp, 'addAutobase before suspend')
  t.ok(iSusp < iRes, 'suspend before resume')
  await client.close()
})

test('ADR-003: close() calls suspend() BEFORE close()', async (t) => {
  const { FakeBlindPeering, calls } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: 'z' + 'a'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  const base = makeFakeAutobase('ff'.repeat(32))
  await client.registerAutobase(base)
  await client.close()
  // The pre-close suspend counts as a suspend call. Assert order.
  const closeIdx = calls.order.indexOf('close')
  const suspIdx = calls.order.indexOf('suspend')
  t.ok(suspIdx >= 0, 'suspend was called')
  t.ok(closeIdx >= 0, 'close was called')
  t.ok(suspIdx < closeIdx,
    'suspend precedes close in the recorded call order')
  t.is(calls.close, 1, 'close called exactly once')
})

test('ADR-003: no-op client (feature-flag off) still exposes suspend/resume/registerCore', async (t) => {
  const { FakeBlindPeering } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: false, // explicit off
    blindPeerKey: 'z' + 'a'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  t.is(typeof client.suspend, 'function')
  t.is(typeof client.resume, 'function')
  t.is(typeof client.registerCore, 'function')
  // All no-ops must resolve without throwing.
  await client.suspend()
  await client.resume()
  const r = await client.registerCore(makeFakeCore('aa'.repeat(32)))
  t.is(r.ok, false)
  t.is(r.reason, 'flag-off')
  await client.close()
})

test('ADR-003: rate limit applies to registerCore too', async (t) => {
  const { FakeBlindPeering } = makeFakeBlindPeeringClass()
  const client = createBlindPeeringClient({
    swarm: makeFakeSwarm(),
    corestore: makeFakeStore(),
    enabled: true,
    blindPeerKey: 'z' + 'a'.repeat(51),
    BlindPeeringClass: FakeBlindPeering
  })
  const core = makeFakeCore('bc'.repeat(32))
  for (let i = 0; i < _internal.RATE_LIMIT_MAX; i++) {
    const r = await client.registerCore(core)
    t.is(r.ok, true, 'core attempt ' + (i + 1) + ' allowed')
  }
  const overflow = await client.registerCore(core)
  t.is(overflow.ok, false)
  t.is(overflow.reason, 'rate-limited')
  await client.close()
})
