// Curva playhead: Autobase in optimistic mode + Hyperbee view.
//
// Every peer appends { type, match_time_ms, wall_clock_ms, by_peer, lamport }
// locally with { optimistic: true }. The host reducer accepts the writer via
// host.ackWriter(from.key) after a per-peer rate-limit check.
//
// Conflict resolution: higher lamport wins; on tie, higher wall_clock_ms wins.
// The apply reducer NEVER mutates a stored event; it only overwrites the single
// 'current' key when a strictly-newer event lands.
//
// Renderer wires state.match_time_ms to <video>.currentTime and state.type to
// play/pause/rate. See renderer/components/VideoPlayer.js.
//
// ADR-002: optimistic mode is chosen over Pattern A relay so chat/playhead do
// not go dark when the human host disconnects.

const Autobase = require('autobase')
const Hyperbee = require('hyperbee')

const RATE_LIMIT_MAX = 10        // events per pubkey per window
const RATE_LIMIT_WINDOW_MS = 1000

// Wave 6 T3: anchor drift threshold. Anchor events (is_anchor: true) are emitted
// by the host every 10s during playback. Receivers only snap when the delta
// against the last known playhead exceeds this threshold; smaller wobble is
// ignored so the host stays authoritative on drift, not on micro-movement.
const ANCHOR_DRIFT_THRESHOLD_MS = 500

/**
 * @param {Corestore} store  parent corestore (will be namespaced)
 * @param {{ isHost: boolean, myPubkey?: string }} opts
 * @returns {Promise<{
 *   setState: (patch: { type: string, match_time_ms: number, rate?: number }) => Promise<void>,
 *   getState: () => Promise<object|null>,
 *   onUpdate: (cb: (state: object) => void) => () => void,
 *   getBase: () => object,
 *   close: () => Promise<void>
 * }>}
 */
async function createPlayhead(store, { isHost, myPubkey = 'local', hostPubkeyHex = null, bootstrap = null } = {}) {
  const namespaced = store.namespace('curva/playhead')
  // Bootstrap: same semantics as chat.js — peer passes the host's autobase
  // primary key so both peers see the same root. Docs verified against
  // https://github.com/holepunchto/autobase (API §, "loading an existing
  // Autobase"). When null we create a fresh root (host path).
  const bootstrapBuf = typeof bootstrap === 'string' && /^[0-9a-fA-F]{64}$/.test(bootstrap)
    ? Buffer.from(bootstrap, 'hex')
    : (bootstrap && bootstrap.length === 32 ? bootstrap : null)

  // T2 (Final Fix Wave): host-gate addWriter control blocks. Mirrors the
  // chat.js:136-152 pattern so a promoted peer cannot forge Pattern B
  // addWriter blocks on the playhead base. `setHostWriter` mutates this at
  // runtime once the host publishes its writer key (room.js host bootstrap).
  let hostWriterHex = hostPubkeyHex ? String(hostPubkeyHex).toLowerCase() : null
  function setHostWriter(hex) {
    if (typeof hex !== 'string' || hex.length === 0) return
    hostWriterHex = hex.toLowerCase()
  }

  // Fix Wave A T2: rate-limit state MUST live outside apply() so the reducer
  // remains pure & deterministic. Rate-limit checks now run at INGRESS (in
  // setState) BEFORE base.append(). Autobase may replay events during rebase;
  // if we gated on rate-limit inside apply, the same event could be accepted
  // once (window clear) and rejected on replay (window full), giving divergent
  // views across peers. See:
  //   https://github.com/holepunchto/autobase (apply must be deterministic)
  const rateLimitWindows = new Map()

  function withinRate(pubkeyHex) {
    const now = Date.now()
    const cutoff = now - RATE_LIMIT_WINDOW_MS
    let arr = rateLimitWindows.get(pubkeyHex)
    if (!arr) {
      arr = []
      rateLimitWindows.set(pubkeyHex, arr)
    }
    // drop old
    while (arr.length > 0 && arr[0] < cutoff) arr.shift()
    if (arr.length >= RATE_LIMIT_MAX) return false
    arr.push(now)
    return true
  }

  // Autobase v7.28 optimistic mode. Bootstrap is `bootstrapBuf` when the
  // caller supplied the host's autobase primary key (peer path); otherwise
  // null so a host constructs a fresh autobase whose key it then broadcasts
  // to peers via the writer-invitation handshake (see workers/main.js
  // `room:hello` frame).
  const base = new Autobase(namespaced, bootstrapBuf, {
    optimistic: true,
    valueEncoding: 'json',
    ackInterval: 1000,
    open(viewStore) {
      const core = viewStore.get({ name: 'playhead-view' })
      return new Hyperbee(core, {
        keyEncoding: 'utf-8',
        valueEncoding: 'json'
      })
    },
    async apply(nodes, view, host) {
      // Fix Wave A T2: apply() is PURE.
      //   - No closure-mutating state (rate windows moved to ingress).
      //   - Only writes we do here go through `view.put(...)` and `host.ackWriter(...)`.
      //   - Same inputs -> same view state, always.
      for (const node of nodes) {
        const v = node.value

        // Wave 8A Pattern B: addWriter control message. Follows the Autobase
        // README pattern (`if (value.addWriter) await host.addWriter(...)`).
        //
        // T2 (Final Fix Wave): host-gate addWriter. Only the writer whose key
        // matches hostWriterHex may author addWriter control blocks. This
        // mirrors chat.js:136-152 so a promoted peer cannot indirectly add
        // its own accomplices. If hostWriterHex is not yet known (pre-host
        // publish grace period) we skip the gate — the host is the only party
        // that appends addWriter blocks in the current UX and any forged block
        // from a peer that lands during grace is transient because the roster
        // is authoritative in Autobase itself.
        if (v && v.addWriter) {
          const writerKey = node.from?.key
          const writerHex = writerKey ? writerKey.toString('hex').toLowerCase() : null
          if (hostWriterHex && writerHex !== hostWriterHex) {
            console.log('[Curva] playhead rejected forged addWriter', {
              writer: (writerHex || '').slice(0, 8),
              host: hostWriterHex.slice(0, 8)
            })
            continue
          }
          try {
            const keyBuf = typeof v.addWriter === 'string'
              ? Buffer.from(v.addWriter, 'hex')
              : v.addWriter
            await host.addWriter(keyBuf, { indexer: v.indexer !== false })
          } catch (err) {
            console.log('[Curva] playhead addWriter apply failed:', err?.message)
          }
          continue
        }

        if (!isValidEvent(v)) continue

        // For optimistic appends from non-writers: ack them so their block is
        // durable. Rate-limiting was moved to setState() ingress in Fix Wave A.
        if (node.optimistic) {
          const writerKey = node.from?.key
          try {
            await host.ackWriter(writerKey)
          } catch (err) {
            // If ack fails we still don't want the reducer to throw and rollback.
            // Log via stdout for the worker log stream; the event is simply not applied.
            console.log('[Curva] playhead ackWriter failed:', err?.message)
            continue
          }
        }

        // Merge into 'current' with lamport / wall_clock_ms resolution.
        const curEntry = await view.get('current')
        const cur = curEntry?.value

        // T3: anchor drift-correction. Anchor events (is_anchor: true) are
        // periodic ticks from the host and MUST NOT flap the playhead if the
        // receiver is already within threshold. When the receiver's current
        // match_time_ms is within ANCHOR_DRIFT_THRESHOLD_MS of the anchor, we
        // ignore the anchor entirely (do not overwrite `current`). Otherwise
        // we snap. Non-anchor events (play/pause/seek/rate) always go through
        // the standard shouldReplace check.
        if (v.is_anchor) {
          if (cur && Math.abs((cur.match_time_ms || 0) - v.match_time_ms) <= ANCHOR_DRIFT_THRESHOLD_MS) {
            continue
          }
          // Above threshold: snap. Force lamport monotonicity so the anchor
          // wins even if it arrived with an old lamport (host-authoritative).
          if (cur && v.lamport <= cur.lamport) {
            v.lamport = cur.lamport + 1
          }
        }
        if (shouldReplace(cur, v)) {
          await view.put('current', v)
        }
      }
    }
  })

  await base.ready()

  // Local lamport counter, bumps on every setState. Peers may see higher
  // lamports from the network; setState picks max+1 to preserve monotonicity.
  let localLamport = 0

  // Bump local lamport whenever we observe a higher one on the view.
  async function observeLamport() {
    const entry = await base.view?.get?.('current').catch(() => null)
    const cur = entry?.value
    if (cur && typeof cur.lamport === 'number' && cur.lamport > localLamport) {
      localLamport = cur.lamport
    }
  }

  // Subscribers.
  const listeners = new Set()
  let lastEmittedLamport = -1
  let lastEmittedWallClock = -1

  async function emitIfNew() {
    try {
      const entry = await base.view.get('current')
      const cur = entry?.value
      if (!cur) return
      if (
        cur.lamport === lastEmittedLamport &&
        cur.wall_clock_ms === lastEmittedWallClock
      ) return
      lastEmittedLamport = cur.lamport
      lastEmittedWallClock = cur.wall_clock_ms
      for (const cb of listeners) {
        try { cb(cur) } catch (err) {
          console.log('[Curva] playhead listener threw:', err?.message)
        }
      }
    } catch (err) {
      console.log('[Curva] playhead emitIfNew failed:', err?.message)
    }
  }

  // Spec Section 7.2: listen to base.on('update'), NOT the inner core update
  // event — the inner core fires mid-rebase and reads are stale.
  base.on('update', () => { emitIfNew() })

  async function setState(patch) {
    if (!patch || typeof patch !== 'object') {
      throw new TypeError('setState requires an object')
    }
    if (!['play', 'pause', 'seek', 'rate'].includes(patch.type)) {
      throw new RangeError('invalid playhead type: ' + patch.type)
    }
    if (typeof patch.match_time_ms !== 'number' || patch.match_time_ms < 0) {
      throw new RangeError('match_time_ms must be a non-negative number')
    }

    // Fix Wave A T2: rate-limit gate at ingress, matching the pre-fix
    // semantics exactly. The pre-fix reducer only rate-limited OPTIMISTIC
    // (non-writer) appends. Writable-path appends went straight through.
    // We preserve that behavior here so the reducer stays pure without
    // regressing the local writer's throughput.
    const isOptimistic = !base.writable
    if (isOptimistic && !withinRate(myPubkey)) {
      const err = new Error('playhead rate limit exceeded')
      err.code = 'RATE_LIMITED'
      throw err
    }

    await observeLamport()
    localLamport += 1

    const event = {
      type: patch.type,
      match_time_ms: Math.floor(patch.match_time_ms),
      wall_clock_ms: Date.now(),
      by_peer: myPubkey,
      lamport: localLamport
    }
    if (patch.type === 'rate' && typeof patch.rate === 'number') {
      event.rate = patch.rate
    }
    // T3: anchor tag propagates end-to-end so the reducer can apply the
    // drift threshold. Non-anchor callers omit this field entirely.
    if (patch.is_anchor === true) {
      event.is_anchor = true
    }

    // Optimistic append: everyone appends optimistically. The host's own
    // reducer will accept because isHost is true (it can call ackWriter on
    // itself; Autobase treats a host's local writer as already-writable).
    await base.append(event, { optimistic: true })
    // ADR-004: immediate foreground ack after a local append. Only fires on
    // indexer-writers (base.ackable is a getter that checks localWriter's
    // isActiveIndexer state — see node_modules/autobase/index.js:246). Post-
    // append ack matters more here than for chat because playhead events
    // drive video sync — every 100ms of ack delay is a frame of drift.
    try { if (base.ackable) await base.ack(false) } catch { /* noop */ }
  }

  async function getState() {
    const entry = await base.view.get('current')
    return entry?.value ?? null
  }

  function onUpdate(cb) {
    if (typeof cb !== 'function') throw new TypeError('onUpdate requires a function')
    listeners.add(cb)
    return () => listeners.delete(cb)
  }

  async function close() {
    listeners.clear()
    try { await base.close() } catch { /* noop */ }
  }

  return { setState, getState, onUpdate, getBase: () => base, setHostWriter, close }
}

function isValidEvent(v) {
  if (!v || typeof v !== 'object') return false
  if (!['play', 'pause', 'seek', 'rate'].includes(v.type)) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.lamport !== 'number' || v.lamport < 0) return false
  if (typeof v.by_peer !== 'string') return false
  if (v.is_anchor !== undefined && typeof v.is_anchor !== 'boolean') return false
  return true
}

// T3: pure helper for testability. Given a current stored state and an anchor
// event, decide whether the anchor should snap the receiver's playhead.
// Returns true iff the delta exceeds ANCHOR_DRIFT_THRESHOLD_MS.
function shouldApplyAnchor(cur, anchor) {
  if (!anchor || anchor.is_anchor !== true) return false
  if (!cur) return true
  const delta = Math.abs((cur.match_time_ms || 0) - (anchor.match_time_ms || 0))
  return delta > ANCHOR_DRIFT_THRESHOLD_MS
}

function shouldReplace(cur, next) {
  if (!cur) return true
  if (next.lamport > cur.lamport) return true
  if (next.lamport === cur.lamport && next.wall_clock_ms > cur.wall_clock_ms) return true
  return false
}

module.exports = {
  createPlayhead,
  // exported for tests only
  _internal: {
    isValidEvent,
    shouldReplace,
    shouldApplyAnchor,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
    ANCHOR_DRIFT_THRESHOLD_MS
  }
}
