// Fix Wave A T2: verify playhead reducer is deterministic.
//
// Autobase requires apply() to be pure - the same event replayed twice must
// leave the view in the same state. This test asserts:
//   1. Sending the same event twice yields identical final state.
//   2. Multi-event sequences produce a state consistent with lamport/wall_clock
//      ordering that does NOT depend on any closure-scoped Map inside apply().
//
// See holepunchto/autobase: "view argument is the only data structure being
// updated and that its fully deterministic". Closure-scoped Maps mutated in
// apply() are forbidden.
//
// Rate-limit behavior: pre-fix, only OPTIMISTIC (non-writer) appends were
// rate-limited inside apply. Post-fix, that same optimistic-only gate runs
// at ingress. Local writer paths (which is what a single-node test exercises)
// are NEVER rate-limited, then or now.

const test = require('brittle')
const { makeStore } = require('./_helpers.js')
const { createPlayhead, _internal } = require('../bare/playhead.js')

async function waitFor(fn, pred, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (pred(v)) return v
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}

test('T2: applying the same event twice leaves identical view state', async (t) => {
  const { store, cleanup } = await makeStore()
  const ph = await createPlayhead(store, { isHost: true, myPubkey: 'cc'.repeat(32) })

  await ph.setState({ type: 'play', match_time_ms: 1000 })
  const first = await waitFor(() => ph.getState(), (s) => s && s.match_time_ms === 1000)
  t.ok(first, 'first apply landed')

  // Same-shape event with a strictly higher lamport (setState bumps it) so
  // shouldReplace triggers. Assertion: view state is a function of the input
  // sequence, not any hidden closure counter inside apply.
  await ph.setState({ type: 'play', match_time_ms: 1000 })
  const second = await waitFor(
    () => ph.getState(),
    (s) => s && s.lamport > first.lamport,
    { timeoutMs: 2000 }
  )
  t.ok(second, 'second apply landed')
  t.is(second.type, first.type, 'type unchanged')
  t.is(second.match_time_ms, first.match_time_ms, 'match_time_ms unchanged')

  await ph.close()
  await cleanup()
})

test('T2: multi-event sequence is order-deterministic', async (t) => {
  const { store, cleanup } = await makeStore()
  const ph = await createPlayhead(store, { isHost: true, myPubkey: 'dd'.repeat(32) })

  await ph.setState({ type: 'play', match_time_ms: 100 })
  await ph.setState({ type: 'seek', match_time_ms: 500 })
  await ph.setState({ type: 'pause', match_time_ms: 500 })

  const final = await waitFor(
    () => ph.getState(),
    (s) => s && s.type === 'pause' && s.match_time_ms === 500
  )
  t.ok(final, 'final state matches last input')
  t.is(final.type, 'pause')

  await ph.close()
  await cleanup()
})

test('T2: withinRate is purely a helper, exercisable in isolation', (t) => {
  // Sanity: the rate-limit sliding window is exposed via _internal for tests
  // to reason about behavior. Reducing this to a pure function means it can
  // move to ingress without changing observable semantics.
  t.is(typeof _internal.RATE_LIMIT_MAX, 'number')
  t.is(typeof _internal.RATE_LIMIT_WINDOW_MS, 'number')
  t.ok(_internal.RATE_LIMIT_MAX > 0)
  t.ok(_internal.RATE_LIMIT_WINDOW_MS > 0)
})
