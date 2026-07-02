// Curva diagnostics: capture playhead sync latency between LOCAL setState and
// REMOTE playhead:update. Ring-buffered in memory (last 10 samples). Exposed to
// the renderer via a dev-only `?diag=1` panel; the numbers are the demo-video
// worthy proof that the P2P layer is real.
//
// Discipline:
//   - No IO. In-memory ring buffer only. No persistence, no PII.
//   - Latency = arrival_wall_clock_ms - event.wall_clock_ms on the receiving
//     peer. When the same peer both emits AND receives its own event this
//     yields ~0ms (correctly identified as loopback, not counted).
//   - Positive samples only; negative deltas are clock skew and dropped.

const RING_CAPACITY = 10

function createLatencyTracker(opts = {}) {
  const { now = () => Date.now(), capacity = RING_CAPACITY } = opts
  let self = opts.self || null
  const samples = [] // { ms, at, from, type }

  function setSelf(pubkey) {
    if (typeof pubkey === 'string' && pubkey.length > 0) self = pubkey
  }

  function record(event, receivedAt = now()) {
    if (!event || typeof event !== 'object') return null
    // Ignore loopback: if we sent the event, we don't measure our own latency.
    if (self && event.by_peer === self) return null
    if (typeof event.wall_clock_ms !== 'number') return null
    const delta = receivedAt - event.wall_clock_ms
    // Clock skew guard: drop non-positive deltas and absurdly large ones (> 60s).
    if (delta <= 0 || delta > 60_000) return null
    samples.push({
      ms: delta,
      at: receivedAt,
      from: (event.by_peer || '').slice(0, 8),
      type: event.type || 'unknown'
    })
    while (samples.length > capacity) samples.shift()
    return delta
  }

  function list() {
    return samples.slice()
  }

  function stats() {
    if (samples.length === 0) {
      return { count: 0, last: null, min: null, max: null, mean: null, p50: null, p95: null }
    }
    const values = samples.map((s) => s.ms).sort((a, b) => a - b)
    const sum = values.reduce((a, b) => a + b, 0)
    const mean = Math.round(sum / values.length)
    const p50 = values[Math.floor(values.length * 0.5)]
    const p95 = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]
    return {
      count: samples.length,
      last: samples[samples.length - 1].ms,
      min: values[0],
      max: values[values.length - 1],
      mean,
      p50,
      p95
    }
  }

  function reset() {
    samples.length = 0
  }

  return { record, list, stats, reset, setSelf }
}

module.exports = { createLatencyTracker, RING_CAPACITY }
