// Curva Phase 4 diagnostics tests: playhead sync latency ring buffer.
// Pure in-memory module; no swarm, no IO. Deterministic clock.

const test = require('brittle')
const { createLatencyTracker, RING_CAPACITY } = require('../bare/diagnostics.js')

test('records positive deltas from remote peers', (t) => {
  let now = 1000
  const tracker = createLatencyTracker({ now: () => now, self: 'me' })
  const delta = tracker.record({ by_peer: 'peer-a', wall_clock_ms: 900, type: 'play' })
  t.is(delta, 100, 'delta = receivedAt - wall_clock_ms')
  t.is(tracker.list().length, 1)
  const s = tracker.list()[0]
  t.is(s.ms, 100)
  t.is(s.type, 'play')
  t.is(s.from, 'peer-a'.slice(0, 8))
})

test('ignores loopback events (our own writes)', (t) => {
  const tracker = createLatencyTracker({ now: () => 1000, self: 'me-pubkey' })
  const delta = tracker.record({ by_peer: 'me-pubkey', wall_clock_ms: 900, type: 'play' })
  t.is(delta, null, 'loopback returns null')
  t.is(tracker.list().length, 0)
})

test('drops non-positive deltas (clock skew guard)', (t) => {
  const tracker = createLatencyTracker({ now: () => 1000, self: 'me' })
  t.is(tracker.record({ by_peer: 'peer', wall_clock_ms: 1000, type: 'play' }), null, 'zero delta')
  t.is(tracker.record({ by_peer: 'peer', wall_clock_ms: 1100, type: 'play' }), null, 'negative delta')
  t.is(tracker.list().length, 0)
})

test('drops absurd deltas (> 60s)', (t) => {
  const tracker = createLatencyTracker({ now: () => 100_000, self: 'me' })
  t.is(tracker.record({ by_peer: 'peer', wall_clock_ms: 0, type: 'play' }), null, '100s delta dropped')
  t.is(tracker.list().length, 0)
})

test('ring buffer caps at capacity (default 10)', (t) => {
  t.is(RING_CAPACITY, 10, 'default cap = 10')
  let now = 1000
  const tracker = createLatencyTracker({ now: () => now, self: 'me' })
  for (let i = 0; i < 15; i++) {
    tracker.record({ by_peer: 'peer-' + i, wall_clock_ms: now - (i + 1) * 10, type: 'play' })
  }
  t.is(tracker.list().length, 10, 'oldest evicted')
})

test('stats: mean, min, max, p50, p95', (t) => {
  const tracker = createLatencyTracker({ now: () => 1000, self: 'me' })
  const values = [100, 200, 300, 400, 500]
  for (const v of values) {
    tracker.record({ by_peer: 'peer', wall_clock_ms: 1000 - v, type: 'play' })
  }
  const s = tracker.stats()
  t.is(s.count, 5)
  t.is(s.min, 100)
  t.is(s.max, 500)
  t.is(s.mean, 300, 'mean of [100..500]')
  t.is(s.p50, 300, 'p50 = median')
  t.is(s.last, 500, 'most recent sample')
})

test('stats: empty tracker returns nulls', (t) => {
  const tracker = createLatencyTracker({ now: () => 1000, self: 'me' })
  const s = tracker.stats()
  t.is(s.count, 0)
  t.is(s.mean, null)
  t.is(s.p50, null)
  t.is(s.last, null)
})

test('setSelf marks loopback after construction', (t) => {
  const tracker = createLatencyTracker({ now: () => 1000 })
  // No self yet: everything counts.
  t.is(tracker.record({ by_peer: 'me', wall_clock_ms: 900, type: 'play' }), 100)
  tracker.setSelf('me')
  t.is(tracker.record({ by_peer: 'me', wall_clock_ms: 900, type: 'play' }), null, 'now filtered')
  t.is(tracker.record({ by_peer: 'other', wall_clock_ms: 900, type: 'play' }), 100)
})

test('reset clears the ring', (t) => {
  const tracker = createLatencyTracker({ now: () => 1000, self: 'me' })
  tracker.record({ by_peer: 'peer', wall_clock_ms: 900, type: 'play' })
  t.is(tracker.list().length, 1)
  tracker.reset()
  t.is(tracker.list().length, 0)
  t.is(tracker.stats().count, 0)
})

test('rejects malformed events without throwing', (t) => {
  const tracker = createLatencyTracker({ now: () => 1000, self: 'me' })
  t.is(tracker.record(null), null)
  t.is(tracker.record(undefined), null)
  t.is(tracker.record({}), null, 'no wall_clock_ms')
  t.is(tracker.record({ by_peer: 'peer' }), null, 'no wall_clock_ms')
  t.is(tracker.record({ wall_clock_ms: 'not-a-number' }), null)
  t.is(tracker.list().length, 0)
})
