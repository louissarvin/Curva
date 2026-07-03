// Final Fix Wave T4 brittle test: swarm suspend/resume dispatcher.
//
// The workers/main.js IPC handlers for `swarm:suspend` / `swarm:resume`
// delegate to these helpers. We assert the helpers call the underlying
// hyperswarm methods exactly once and never throw.
//
// Hyperswarm docs (https://github.com/holepunchto/hyperswarm) prescribe
// suspend/resume for mobile-adjacent hardware; wiring this correctly is the
// difference between a battery drain and a well-behaved background app.

const test = require('brittle')
const { suspendSwarm, resumeSwarm } = require('../bare/swarmLifecycle.js')

function makeFakeSwarm(opts = {}) {
  const s = { suspendCount: 0, resumeCount: 0 }
  if (opts.suspend !== false) {
    s.suspend = async () => { s.suspendCount++ }
  }
  if (opts.resume !== false) {
    s.resume = async () => { s.resumeCount++ }
  }
  if (opts.throwOnSuspend) {
    s.suspend = async () => { throw new Error('boom') }
  }
  if (opts.throwOnResume) {
    s.resume = async () => { throw new Error('boom') }
  }
  return s
}

test('T4: suspendSwarm calls swarm.suspend exactly once', async (t) => {
  const swarm = makeFakeSwarm()
  const res = await suspendSwarm(swarm)
  t.ok(res.ok)
  t.is(swarm.suspendCount, 1)
})

test('T4: resumeSwarm calls swarm.resume exactly once', async (t) => {
  const swarm = makeFakeSwarm()
  const res = await resumeSwarm(swarm)
  t.ok(res.ok)
  t.is(swarm.resumeCount, 1)
})

test('T4: suspendSwarm on older hyperswarm without .suspend returns ok with note', async (t) => {
  const swarm = makeFakeSwarm({ suspend: false })
  const res = await suspendSwarm(swarm)
  t.ok(res.ok, 'still ok so caller can ack')
  t.is(res.note, 'suspend-not-supported')
})

test('T4: resumeSwarm on older hyperswarm without .resume returns ok with note', async (t) => {
  const swarm = makeFakeSwarm({ resume: false })
  const res = await resumeSwarm(swarm)
  t.ok(res.ok)
  t.is(res.note, 'resume-not-supported')
})

test('T4: suspendSwarm never throws when underlying suspend rejects', async (t) => {
  const swarm = makeFakeSwarm({ throwOnSuspend: true })
  const res = await suspendSwarm(swarm)
  t.absent(res.ok)
  t.is(res.error, 'boom')
})

test('T4: resumeSwarm never throws when underlying resume rejects', async (t) => {
  const swarm = makeFakeSwarm({ throwOnResume: true })
  const res = await resumeSwarm(swarm)
  t.absent(res.ok)
  t.is(res.error, 'boom')
})

test('T4: null swarm reference is treated as unsupported (never throws)', async (t) => {
  const s = await suspendSwarm(null)
  const r = await resumeSwarm(null)
  t.ok(s.ok)
  t.is(s.note, 'suspend-not-supported')
  t.ok(r.ok)
  t.is(r.note, 'resume-not-supported')
})

test('T4: repeated suspend then resume calls are counted independently', async (t) => {
  const swarm = makeFakeSwarm()
  await suspendSwarm(swarm)
  await suspendSwarm(swarm)
  await resumeSwarm(swarm)
  t.is(swarm.suspendCount, 2)
  t.is(swarm.resumeCount, 1)
})
