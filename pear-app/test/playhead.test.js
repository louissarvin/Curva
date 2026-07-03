// Phase 1 brittle test: playhead reducer (Autobase + Hyperbee view).
//
// A single-node "host" plays the role of the reducer and the writer here. The
// two-peer replication path is exercised in a live two-window run (documented
// in the ARCHITECTURE.md Section 2.2 flow), not in this unit test.

const test = require('brittle')
const { makeStore } = require('./_helpers.js')
const { createPlayhead, _internal } = require('../bare/playhead.js')

test('createPlayhead returns the expected surface', async (t) => {
  const { store, cleanup } = await makeStore()
  const ph = await createPlayhead(store, { isHost: true, myPubkey: 'aa'.repeat(32) })
  t.is(typeof ph.setState, 'function')
  t.is(typeof ph.getState, 'function')
  t.is(typeof ph.onUpdate, 'function')
  t.is(typeof ph.close, 'function')
  await ph.close()
  await cleanup()
})

test('setState + getState round trip: current state is what we wrote', async (t) => {
  const { store, cleanup } = await makeStore()
  const ph = await createPlayhead(store, { isHost: true, myPubkey: 'aa'.repeat(32) })
  await ph.setState({ type: 'play', match_time_ms: 1000 })

  // Wait until the reducer applies the append. We poll getState until it
  // returns a non-null value or a timeout elapses.
  const state = await waitFor(() => ph.getState(), (s) => s && s.type === 'play')

  t.ok(state, 'state exists')
  t.is(state.type, 'play')
  t.is(state.match_time_ms, 1000)
  t.is(typeof state.wall_clock_ms, 'number')
  t.is(typeof state.lamport, 'number')
  t.is(state.by_peer, 'aa'.repeat(32))

  await ph.close()
  await cleanup()
})

test('lamport ordering: higher lamport wins even if wall-clock is older', async (t) => {
  const { store, cleanup } = await makeStore()
  const ph = await createPlayhead(store, { isHost: true, myPubkey: 'bb'.repeat(32) })

  // First: lamport=1, wall_clock=now.
  await ph.setState({ type: 'play', match_time_ms: 500 })
  await waitFor(() => ph.getState(), (s) => s && s.match_time_ms === 500)

  // Second: strictly newer lamport wins.
  await ph.setState({ type: 'seek', match_time_ms: 2500 })
  const after = await waitFor(() => ph.getState(), (s) => s && s.match_time_ms === 2500)

  t.is(after.type, 'seek')
  t.is(after.match_time_ms, 2500)

  await ph.close()
  await cleanup()
})

test('shouldReplace tie-breaker unit: same lamport -> later wall_clock wins', (t) => {
  const cur = { lamport: 5, wall_clock_ms: 1000, type: 'play', match_time_ms: 100 }
  const next = { lamport: 5, wall_clock_ms: 1500, type: 'pause', match_time_ms: 200 }
  t.ok(_internal.shouldReplace(cur, next), 'later wall_clock replaces current')
  t.absent(_internal.shouldReplace(next, cur), 'earlier wall_clock does not replace')
})

test('shouldReplace rejects strictly older lamport', (t) => {
  const cur = { lamport: 10, wall_clock_ms: 100, type: 'play', match_time_ms: 0 }
  const next = { lamport: 5, wall_clock_ms: 100000, type: 'seek', match_time_ms: 0 }
  t.absent(_internal.shouldReplace(cur, next), 'older lamport never wins')
})

test('isValidEvent rejects malformed events', (t) => {
  t.absent(_internal.isValidEvent(null))
  t.absent(_internal.isValidEvent({}))
  t.absent(_internal.isValidEvent({ type: 'nope', match_time_ms: 0, wall_clock_ms: 0, lamport: 0, by_peer: 'a' }))
  t.absent(_internal.isValidEvent({ type: 'play', match_time_ms: -1, wall_clock_ms: 0, lamport: 0, by_peer: 'a' }))
  t.ok(_internal.isValidEvent({ type: 'play', match_time_ms: 0, wall_clock_ms: 1, lamport: 0, by_peer: 'a' }))
})

test('setState rejects bad input', async (t) => {
  const { store, cleanup } = await makeStore()
  const ph = await createPlayhead(store, { isHost: true, myPubkey: 'cc'.repeat(32) })

  await t.exception.all(() => ph.setState(null), 'null rejected')
  await t.exception.all(() => ph.setState({ type: 'nope', match_time_ms: 0 }), 'bad type rejected')
  await t.exception.all(() => ph.setState({ type: 'play', match_time_ms: -1 }), 'negative time rejected')

  await ph.close()
  await cleanup()
})

test('onUpdate fires at least once after setState', async (t) => {
  const { store, cleanup } = await makeStore()
  const ph = await createPlayhead(store, { isHost: true, myPubkey: 'dd'.repeat(32) })

  let calls = 0
  let lastState = null
  const off = ph.onUpdate((state) => {
    calls++
    lastState = state
  })

  await ph.setState({ type: 'play', match_time_ms: 750 })
  // Give the update tick time to fire.
  await waitMs(150)

  t.ok(calls >= 1, `onUpdate fired ${calls} time(s)`)
  t.ok(lastState && lastState.match_time_ms === 750, 'onUpdate delivered the right state')

  off()
  await ph.close()
  await cleanup()
})

// T3 Wave 6: anchor drift correction.

test('shouldApplyAnchor: below threshold is ignored', (t) => {
  const cur = { match_time_ms: 5000, lamport: 1, wall_clock_ms: 1, type: 'play', by_peer: 'a' }
  const anchor = { match_time_ms: 5300, is_anchor: true, lamport: 2, wall_clock_ms: 2, type: 'seek', by_peer: 'b' }
  t.absent(_internal.shouldApplyAnchor(cur, anchor), '300ms drift < 500ms threshold')
})

test('shouldApplyAnchor: above threshold snaps', (t) => {
  const cur = { match_time_ms: 5000, lamport: 1, wall_clock_ms: 1, type: 'play', by_peer: 'a' }
  const anchor = { match_time_ms: 6600, is_anchor: true, lamport: 2, wall_clock_ms: 2, type: 'seek', by_peer: 'b' }
  t.ok(_internal.shouldApplyAnchor(cur, anchor), '1600ms drift > 500ms threshold')
})

test('shouldApplyAnchor: exactly at threshold is ignored', (t) => {
  const cur = { match_time_ms: 5000, lamport: 1, wall_clock_ms: 1, type: 'play', by_peer: 'a' }
  const anchor = { match_time_ms: 5500, is_anchor: true, lamport: 2, wall_clock_ms: 2, type: 'seek', by_peer: 'b' }
  t.absent(_internal.shouldApplyAnchor(cur, anchor), 'exactly 500ms is <= threshold')
})

test('shouldApplyAnchor: non-anchor event is never applied via this path', (t) => {
  const cur = { match_time_ms: 5000, lamport: 1, wall_clock_ms: 1, type: 'play', by_peer: 'a' }
  const notAnchor = { match_time_ms: 9999, lamport: 5, wall_clock_ms: 2, type: 'seek', by_peer: 'b' }
  t.absent(_internal.shouldApplyAnchor(cur, notAnchor), 'is_anchor missing -> false')
})

test('shouldApplyAnchor: no current state -> always snap', (t) => {
  const anchor = { match_time_ms: 100, is_anchor: true, lamport: 1, wall_clock_ms: 1, type: 'seek', by_peer: 'a' }
  t.ok(_internal.shouldApplyAnchor(null, anchor), 'first anchor snaps')
})

test('isValidEvent accepts optional is_anchor boolean and rejects non-boolean', (t) => {
  t.ok(_internal.isValidEvent({ type: 'seek', match_time_ms: 0, wall_clock_ms: 1, lamport: 0, by_peer: 'a', is_anchor: true }))
  t.ok(_internal.isValidEvent({ type: 'seek', match_time_ms: 0, wall_clock_ms: 1, lamport: 0, by_peer: 'a' }))
  t.absent(_internal.isValidEvent({ type: 'seek', match_time_ms: 0, wall_clock_ms: 1, lamport: 0, by_peer: 'a', is_anchor: 'yes' }))
})

test('anchor applied through the reducer: within-threshold ignored, above-threshold snaps', async (t) => {
  const { store, cleanup } = await makeStore()
  const ph = await createPlayhead(store, { isHost: true, myPubkey: 'ee'.repeat(32) })

  // Seed with an initial play at 5000ms.
  await ph.setState({ type: 'play', match_time_ms: 5000 })
  await waitFor(() => ph.getState(), (s) => s && s.match_time_ms === 5000)

  // Anchor at 5300 (300ms drift). Should NOT overwrite the stored state.
  await ph.setState({ type: 'seek', match_time_ms: 5300, is_anchor: true })
  await waitMs(120)
  const after1 = await ph.getState()
  t.is(after1.match_time_ms, 5000, 'small drift ignored')

  // Anchor at 7000 (2000ms drift). Should overwrite.
  await ph.setState({ type: 'seek', match_time_ms: 7000, is_anchor: true })
  const after2 = await waitFor(() => ph.getState(), (s) => s && s.match_time_ms === 7000)
  t.is(after2.match_time_ms, 7000, 'large drift snapped')
  t.is(after2.is_anchor, true, 'anchor flag preserved on stored state')

  await ph.close()
  await cleanup()
})

// Final Fix Wave T-D3: mirror of the chat.test.js assertion. The playhead
// Autobase must expose both 'writable' and 'unwritable' so workers/main.js
// can emit 'room:base-writable' / 'room:base-unwritable' onto the IPC pipe.
// Autobase README pairs these events at
// pear-app/node_modules/autobase/README.md:287.
test('T-D3: playhead base accepts unwritable listener alongside writable', async (t) => {
  const { store, cleanup } = await makeStore()
  const ph = await createPlayhead(store, { isHost: true, myPubkey: 'aa'.repeat(32) })
  const base = ph.getBase()
  const onWritable = () => {}
  const onUnwritable = () => {}
  base.on('writable', onWritable)
  base.on('unwritable', onUnwritable)
  t.is(base.listenerCount('writable'), 1, 'writable listener registered')
  t.is(base.listenerCount('unwritable'), 1, 'unwritable listener registered')
  base.off('writable', onWritable)
  base.off('unwritable', onUnwritable)
  t.is(base.listenerCount('writable'), 0)
  t.is(base.listenerCount('unwritable'), 0)
  await ph.close()
  await cleanup()
})

// -- helpers ---------------------------------------------------------------

async function waitFor(fn, pred, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const value = await fn()
    if (pred(value)) return value
    await waitMs(intervalMs)
  }
  throw new Error('waitFor: timed out')
}

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
