// Curva chat: Autobase in optimistic mode + Hyperbee view keyed by timestamp.
//
// Message shape (per ARCHITECTURE.md Section 5.3):
//   { type:'msg', text, by_peer, match_time_ms, wall_clock_ms, lang? }
//
// Hyperbee key: chat/${padded wall_clock_ms}/${by_peer.slice(0,8)}
// Padding to 16 chars keeps range scans lexicographically ordered.
//
// Goal cluster detection: sliding window of last 20 msgs; if 5+ msgs arrived
// within 3 seconds, emit chat:goal-cluster. Immutable log — we NEVER mutate
// stored messages; the cluster event is emissive only.
//
// Rate limits (host reducer): 3 msgs/sec/peer + 30 msgs/min/peer.
// Text sanitation: strip control chars, trim, cap at 280 chars.

const Autobase = require('autobase')
const Hyperbee = require('hyperbee')

const MAX_CHARS = 280
const RATE_SEC_MAX = 3
const RATE_SEC_WINDOW_MS = 1000
const RATE_MIN_MAX = 30
const RATE_MIN_WINDOW_MS = 60_000

const GOAL_CLUSTER_COUNT = 5
const GOAL_CLUSTER_WINDOW_MS = 3000
const RECENT_WINDOW_SIZE = 20

// F1 Wave 3: chat-scrubber version markers.
//
// Every apply() increments an internal counter. Every APPLY_MARKER_INTERVAL
// nodes we snapshot the current `base.view.version` + the last observed
// `match_time_ms` into a bounded ring so the renderer can build a "rewind to
// kickoff" scrubber.
//
// Docs verified 2026-07-10:
//   * hyperbee.checkout(version) — pear-app/node_modules/hyperbee/index.js:762
//     Returns a new Hyperbee bound to a hypercore snapshot at that version.
//     https://docs.pears.com/reference/building-blocks/hyperbee/#beecheckoutversion
//   * hyperbee.version — pear-app/node_modules/hyperbee/index.js:467
//     Reads Math.max(1, checkout || core.length); the value peers can pin.
//   * autobase.view — pear-app/node_modules/autobase/index.js:187
//     The Hyperbee produced by the `open(viewStore)` handler. Reused here.
const APPLY_MARKER_INTERVAL = 10
const VERSION_MARKER_CAP = 1024

// F3 Hyperbee goal shard. 3-digit zero-padded minute covers 000..130
// (regulation + full extra time in a knockout). Root-bee keys under
// `match/goals/<paddedMinute>/<goalId>`. NOT inside bee.sub(): watchers are
// not supported on subs (docs: https://docs.pears.com/reference/building-blocks/hyperbee/,
// "Watchers are not supported on subs or checkouts. Use `range` to narrow the
// scope on the root bee instead."). The existing base.on('update', emitNew)
// pipeline scans both prefixes with createReadStream({gt, lt}).
const MAX_GOAL_MINUTE = 130
const GOAL_ID_MAX_LEN = 64
const MATCH_ID_MAX_LEN = 64
const SCORER_MAX_LEN = 64
const TEAM_NAME_MAX_LEN = 64

// F1 Wave 3: dedicated error class for illegal writes through a checkout
// handle. Renderer code that catches this can silently discard the write and
// resurface the scrubber affordance. Never wrap this in a stack-leaking body:
// the message stays generic ("checkout is read-only") so a compromised peer
// cannot fingerprint internal state from a bounce-back error.
class CheckoutReadOnly extends Error {
  constructor(message = 'checkout is read-only') {
    super(message)
    this.name = 'CheckoutReadOnly'
    this.code = 'CHECKOUT_READONLY'
  }
}

/**
 * @param {Corestore} store
 * @param {{ myPubkey?: string }} [opts]
 */
async function createChat(store, { myPubkey = 'local', hostPubkeyHex = null, bootstrap = null } = {}) {
  const namespaced = store.namespace('curva/chat')
  // Bootstrap: when non-null (peer path), passes the host's autobase primary
  // key so this peer's Autobase converges onto the host's shared root. When
  // null (host path or standalone), creates a fresh autobase whose key must
  // later be broadcast to peers. Verified against the Autobase README:
  //   "If loading an existing Autobase then set `bootstrap` to `base.key`,
  //    otherwise pass `bootstrap` as null or omit."
  // (https://github.com/holepunchto/autobase README, § API).
  const bootstrapBuf = typeof bootstrap === 'string' && /^[0-9a-fA-F]{64}$/.test(bootstrap)
    ? Buffer.from(bootstrap, 'hex')
    : (bootstrap && bootstrap.length === 32 ? bootstrap : null)

  // Fix Wave A T2: rate-limit state is INGRESS-ONLY. It MUST NOT be mutated
  // from inside apply() because Autobase requires apply to be deterministic
  // (see holepunchto/autobase README: "the view argument is the only data
  // structure being updated and that its fully deterministic"). Closure Maps
  // mutated in apply() would give different results on rebase/replay and
  // diverge peer views. Rate-limit is now enforced in send()/sendSystem()
  // BEFORE base.append().
  const rateWindowsSec = new Map()
  const rateWindowsMin = new Map()

  // Wave 7 T1: track which writer pubkey may sign system:tip-ack / system:tip-congrats
  // announcements. Set by room.js after the host publishes room/host-tip-address.
  // hostWriterHex is the hex form of the writer core key that host uses.
  // For anti-spoofing on system messages we require:
  //   - system:tip-ack: written by hostWriterHex (host reducer only)
  //   - system:tip-congrats: written by hostWriterHex OR by the tipper for that tx
  //   - system:tip: written by the tipper (by_peer field must equal writer key OR
  //     match a tracked confirmed-tipper for that tx_hash)
  let hostWriterHex = hostPubkeyHex ? String(hostPubkeyHex).toLowerCase() : null

  // Wave 8A: authorized-writer roster. The host promotes peers to Autobase
  // indexers via addWriter (Pattern B). Their chat writer key is added here
  // so authorship checks on system:tip / system:tip-congrats treat promoted
  // writers as trusted tippers-for-their-own-tx. system:tip-ack STILL requires
  // hostWriterHex (only the host can sign a receipt).
  const authorizedWriters = new Set()
  function addAuthorizedWriter(hex) {
    if (typeof hex !== 'string' || hex.length === 0) return
    authorizedWriters.add(hex.toLowerCase())
  }
  function isAuthorizedWriter(hex) {
    return authorizedWriters.has(hex)
  }

  // F1 Wave 3: version-marker ring. Populated OUTSIDE apply() by an
  // 'update' listener because apply() must remain pure (holepunchto/autobase
  // README: "the view argument is the only data structure being updated and
  // that its fully deterministic"). We only READ base.view.version + the
  // trailing message's match_time_ms and push a snapshot when the increment
  // between two updates crosses APPLY_MARKER_INTERVAL applied nodes.
  //
  // Ring is a bounded array; when it exceeds VERSION_MARKER_CAP we drop the
  // OLDEST entry (naive-LRU). Callers get the latest N markers via
  // getVersions({limit}). Emission is done via versionMarkerListeners so the
  // renderer can subscribe with onVersionMarker(cb).
  const versionMarkers = []
  const versionMarkerListeners = new Set()
  let markerNodeCounter = 0
  let lastMarkerVersion = -1
  let lastAppliedMatchTimeMs = 0
  let lastAppliedWallClockMs = 0

  function pushVersionMarker(version, matchTimeMs, wallClockMs) {
    // Never regress: if a rebase truncates the view and lowers `version`, we
    // simply skip pushing the smaller marker rather than emitting a bogus
    // "rewind" event. Autobase handles view truncation at the reducer level;
    // the scrubber will pick up the new tip on the next apply.
    if (version <= lastMarkerVersion) return
    const marker = {
      version,
      matchTimeMs: Number.isFinite(matchTimeMs) ? matchTimeMs : 0,
      wallClockMs: Number.isFinite(wallClockMs) ? wallClockMs : Date.now()
    }
    versionMarkers.push(marker)
    lastMarkerVersion = version
    if (versionMarkers.length > VERSION_MARKER_CAP) {
      versionMarkers.shift()
    }
    for (const cb of versionMarkerListeners) {
      try { cb(marker) } catch (err) {
        console.log('[Curva] chat version-marker listener threw:', err?.message)
      }
    }
  }

  // Spectator tier (Autopass-style read-only): keys added here are peers
  // admitted as reader-tier by room.js. They are NEVER registered with
  // Autobase via base.append({addWriter}), so autobase itself already refuses
  // any append from them at the linearizer level (source:
  // pear-app/node_modules/autobase/lib/apply-state.js). This Set is a
  // defense-in-depth gate: even if a reader manages to slip a node through
  // (e.g. rebase edge case), apply() silently drops it here.
  // See `memory/impl_autopass_reader.md`.
  const readerWriters = new Set()
  function addReaderKey(hex) {
    if (typeof hex !== 'string' || hex.length === 0) return
    readerWriters.add(hex.toLowerCase())
  }
  function removeReaderKey(hex) {
    if (typeof hex !== 'string' || hex.length === 0) return
    readerWriters.delete(hex.toLowerCase())
  }
  function isReaderKey(hex) {
    return readerWriters.has(String(hex || '').toLowerCase())
  }

  // Fix Wave A T2: confirmed-tipper tracking is persisted to the Hyperbee view
  // (key = `tip-writer/<lowercased tx_hash>`, value = writerHex). Writing is
  // idempotent: rebase replays the same put(key, value) which is a no-op after
  // the first apply. This keeps apply() pure & rebase-safe while preserving
  // the anti-spoofing check for system:tip-congrats. In-memory `Map`s inside
  // apply(nodes, view) are forbidden (see holepunchto/autobase README).
  function txWriterKey(txHash) {
    return 'tip-writer/' + String(txHash).toLowerCase()
  }
  async function readTxWriter(view, txHash) {
    if (typeof txHash !== 'string' || txHash.length === 0) return null
    try {
      const entry = await view.get(txWriterKey(txHash))
      return entry?.value?.writerHex || null
    } catch { return null }
  }

  function withinRate(pubkeyHex) {
    const now = Date.now()

    let secArr = rateWindowsSec.get(pubkeyHex)
    if (!secArr) { secArr = []; rateWindowsSec.set(pubkeyHex, secArr) }
    const secCutoff = now - RATE_SEC_WINDOW_MS
    while (secArr.length > 0 && secArr[0] < secCutoff) secArr.shift()
    if (secArr.length >= RATE_SEC_MAX) return false

    let minArr = rateWindowsMin.get(pubkeyHex)
    if (!minArr) { minArr = []; rateWindowsMin.set(pubkeyHex, minArr) }
    const minCutoff = now - RATE_MIN_WINDOW_MS
    while (minArr.length > 0 && minArr[0] < minCutoff) minArr.shift()
    if (minArr.length >= RATE_MIN_MAX) return false

    secArr.push(now)
    minArr.push(now)
    return true
  }

  const base = new Autobase(namespaced, bootstrapBuf, {
    optimistic: true,
    valueEncoding: 'json',
    ackInterval: 1000,
    open(viewStore) {
      const core = viewStore.get({ name: 'chat-view' })
      return new Hyperbee(core, {
        keyEncoding: 'utf-8',
        valueEncoding: 'json'
      })
    },
    // Fix Wave A T2: apply() is PURE.
    //   - No mutation of closure-scoped Maps (rate limits + confirmedTippersByTx
    //     removed).
    //   - All state lives in `view` (Hyperbee). Writes are idempotent: same
    //     input -> same put; a replay during rebase re-puts the same value.
    //   - Rate-limit enforcement moved to send()/sendSystem() (ingress).
    //   - Anti-spoofing checks remain — they are pure validations, not side
    //     effects.
    async apply(nodes, view, host) {
      for (const node of nodes) {
        const v = node.value

        // Wave 8A Pattern B: addWriter control message. The host peer appends
        // { addWriter: <32-byte-buf|hex> } and every reducer replaying this
        // block promotes the writer via host.addWriter (Autobase README:
        // "if (value.addWriter) await host.addWriter(value.addWriter, { indexer: true })").
        // Only the host writer key is allowed to author addWriter blocks —
        // otherwise any promoted peer could indirectly add its own accomplices.
        if (v && v.addWriter) {
          const writerKey = node.from?.key
          const writerHex = writerKey ? writerKey.toString('hex').toLowerCase() : null
          if (hostWriterHex && writerHex !== hostWriterHex) {
            console.log('[Curva] chat rejected forged addWriter', { writer: (writerHex || '').slice(0, 8) })
            continue
          }
          try {
            const keyBuf = typeof v.addWriter === 'string'
              ? Buffer.from(v.addWriter, 'hex')
              : v.addWriter
            await host.addWriter(keyBuf, { indexer: v.indexer !== false })
          } catch (err) {
            console.log('[Curva] chat addWriter apply failed:', err?.message)
          }
          continue
        }

        if (!isValidMessage(v)) continue

        const writerKey = node.from?.key
        const writerHex = writerKey ? writerKey.toString('hex').toLowerCase() : 'unknown'

        // Spectator-tier denylist. Reader-tier peers are not autobase writers
        // (see room.js handleWriterRequest reader branch), but this is a
        // belt-and-suspenders drop: if for any reason a node authored by a
        // reader hex reaches apply(), we silently drop it before it can hit
        // view.put. Exception: `system:reader-joined` is peer-broadcast roster
        // metadata authored by the HOST (not by the reader itself), so it is
        // NOT dropped by the reader check. Its own host-only gate below still
        // rejects any non-host writer forging a reader-joined message.
        if (v.type !== 'system:reader-joined' && readerWriters.has(writerHex)) {
          console.log('[Curva] chat rejected reader-tier append', {
            writer: writerHex.slice(0, 8), type: v?.type
          })
          continue
        }

        // Wave 7 T1 anti-spoofing: enforce authorship rules on system messages
        // BEFORE ack/put. Non-authoritative writers may not forge tip receipts.
        if (v.type === 'system:tip-ack' && !isAuthorizedTipAck(writerHex)) {
          console.log('[Curva] chat rejected forged system:tip-ack', { writer: writerHex.slice(0, 8) })
          continue
        }
        // Wave 10 anti-spoofing: `system:pool-opened`, `system:match-result`,
        // and `system:pool-payout` are HOST-ONLY messages. Only the writer
        // whose hex matches hostWriterHex may append them. Any other writer's
        // append is silently dropped at the reducer so peers cannot forge
        // "pool settled" broadcasts. Matches the same gate model as
        // system:tip-ack (host-only). See ARCHITECTURE.md Wave 10 header +
        // github.com/holepunchto/autobase multi-writer README for the pattern.
        if (
          (v.type === 'system:pool-opened' ||
            v.type === 'system:match-result' ||
            v.type === 'system:pool-payout') &&
          !isAuthorizedHostSystem(writerHex)
        ) {
          console.log('[Curva] chat rejected forged host system message', {
            type: v.type,
            writer: writerHex.slice(0, 8),
          })
          continue
        }
        // Wave 13A: `system:commentary` (QVAC LLM room commentator) is a
        // host-only broadcast. Mirrors the pool-lifecycle gate exactly: any
        // writer other than hostWriterHex has their message silently dropped
        // at apply() so peers can never fabricate AI commentary in the chat
        // log. Pre-init grace (host writer not known yet) is permitted.
        if (v.type === 'system:commentary' && !isAuthorizedHostSystem(writerHex)) {
          console.log('[Curva] chat rejected forged system:commentary', {
            writer: writerHex.slice(0, 8)
          })
          continue
        }
        // Wave 14: `system:attendance-issued` is a host-only pass mint. The
        // shape carries the peer address + host EIP-191 signature so any peer
        // can ecrecover offline; only the host writer key may append it. Same
        // gate model as system:tip-ack / system:commentary.
        if (v.type === 'system:attendance-issued' && !isAuthorizedHostSystem(writerHex)) {
          console.log('[Curva] chat rejected forged system:attendance-issued', {
            writer: writerHex.slice(0, 8)
          })
          continue
        }
        // F3 Hyperbee goal shard: `system:goal` is host-only. Same gate model
        // as system:tip-ack / system:attendance-issued. A non-host writer's
        // optimistic append is silently dropped (no ackWriter, no view.put)
        // so peers cannot forge scoreline events into the room log.
        if (v.type === 'system:goal' && !isAuthorizedHostSystem(writerHex)) {
          console.log('[Curva] chat rejected forged system:goal', {
            writer: writerHex.slice(0, 8)
          })
          continue
        }
        // Wave 13B: `system:bot-reply` is host-only. The room host is the
        // single peer that runs the QVAC LLM + MCP client and broadcasts the
        // roomBot's answer. Peers can still emit `system:bot-query` freely
        // (that shape check runs in isValidMessage above). This prevents a
        // compromised peer from forging fake tool-call receipts into the log.
        if (v.type === 'system:bot-reply' && !isAuthorizedHostSystem(writerHex)) {
          console.log('[Curva] chat rejected forged system:bot-reply', {
            writer: writerHex.slice(0, 8)
          })
          continue
        }
        // D2 demo mode: `system:prediction-settle` is host-only. Any peer can
        // stake (`system:prediction-stake` is intentionally peer-allowed), but
        // only the host publishes the settlement receipt. Non-host settle
        // attempts are silently dropped.
        if (v.type === 'system:prediction-settle' && !isAuthorizedHostSystem(writerHex)) {
          console.log('[Curva] chat rejected forged system:prediction-settle', {
            writer: writerHex.slice(0, 8)
          })
          continue
        }
        // Spectator tier roster broadcast. HOST-ONLY: the host publishes this
        // when a reader-tier invitation is admitted so peers can refresh their
        // roster UI without polling roomState. Same gate model as
        // system:commentary / system:pool-opened.
        if (v.type === 'system:reader-joined' && !isAuthorizedHostSystem(writerHex)) {
          console.log('[Curva] chat rejected forged system:reader-joined', {
            writer: writerHex.slice(0, 8)
          })
          continue
        }
        if (v.type === 'system:tip' && !(await isAuthorizedSystemTipView(view, writerHex, v))) {
          console.log('[Curva] chat rejected unauthorized system:tip', { writer: writerHex.slice(0, 8), tx: v.tx_hash?.slice(0, 10) })
          continue
        }
        if (v.type === 'system:tip-congrats' && !(await isAuthorizedTipCongratsView(view, writerHex, v))) {
          console.log('[Curva] chat rejected unauthorized system:tip-congrats', { writer: writerHex.slice(0, 8) })
          continue
        }

        if (node.optimistic) {
          try {
            await host.ackWriter(writerKey)
          } catch (err) {
            console.log('[Curva] chat ackWriter failed:', err?.message)
            continue
          }
        }

        // Idempotent view write: `put(txWriterKey(tx), { writerHex })` binds a
        // txHash to the first writer that reduced its `system:tip`. On rebase
        // the same node re-puts the same value → state is identical. This
        // replaces the pre-Fix-Wave-A closure Map that mutated inside apply.
        if (v.type === 'system:tip' && typeof v.tx_hash === 'string') {
          const existing = await readTxWriter(view, v.tx_hash)
          if (!existing) {
            await view.put(txWriterKey(v.tx_hash), { writerHex })
          }
        }

        const key = chatKey(v)
        await view.put(key, v)
      }
    }
  })

  await base.ready()

  // Emission tracking. We keep a last-seen key PER prefix and range-scan for
  // anything above it on each 'update'. Two prefixes are tracked: `chat/*`
  // (regular chat + host-only system chat rows) and `match/goals/*` (F3 goal
  // shard). Separate cursors prevent the two prefixes from interfering because
  // 'match/' is lex-less-than 'chat/', so a single cursor over the whole tail
  // would miss keys under the smaller prefix once the larger one advanced.
  let lastSeenKey = 'chat/0'
  let lastGoalKey = 'match/goals/'
  const messageListeners = new Set()
  const clusterListeners = new Set()

  // Sliding window for goal-cluster detection. Populated only by chat rows,
  // NOT by system:goal shard rows (goal-cluster detection is about chat storm
  // heuristics, not authoritative match events).
  const recentWindow = [] // { wall_clock_ms, key, match_time_ms }
  const clustersEmitted = new Set()

  async function emitNew() {
    // Two-range scan: chat/* first, then match/goals/*. Both live on the root
    // bee. Docs-verified pattern (https://docs.pears.com/reference/building-blocks/hyperbee/):
    // "Watchers are not supported on subs or checkouts. Use `range` to narrow
    //  the scope on the root bee instead." We use createReadStream({gt, lt})
    // rather than watch() because base.on('update', emitNew) already fires on
    // every autobase update, so adding bee.watch() would double-fire.
    const ranges = [
      {
        name: 'chat',
        getCursor: () => lastSeenKey,
        setCursor: (k) => { lastSeenKey = k },
        gt: () => lastSeenKey,
        lt: 'chat0', // 'chat0' > 'chat/' lex; caps the range at end-of-prefix.
        isGoal: false
      },
      {
        name: 'goals',
        getCursor: () => lastGoalKey,
        setCursor: (k) => { lastGoalKey = k },
        gt: () => lastGoalKey,
        lt: 'match/goals0', // '0' > '/' lex; caps at end-of-prefix.
        isGoal: true
      }
    ]

    for (const range of ranges) {
      let stream
      try {
        stream = base.view.createReadStream({
          gt: range.gt(),
          lt: range.lt
        })
      } catch (err) {
        console.log('[Curva] chat createReadStream failed for', range.name, ':', err?.message)
        continue
      }

      const batch = []
      try {
        for await (const entry of stream) {
          batch.push(entry)
        }
      } catch (err) {
        console.log('[Curva] chat stream errored for', range.name, ':', err?.message)
        continue
      }

      if (batch.length === 0) continue

      batch.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

      for (const entry of batch) {
        const msg = entry.value
        range.setCursor(entry.key)
        // Only chat rows feed the goal-cluster sliding window. Goal-shard rows
        // are authoritative match events, not chat storm signals.
        if (!range.isGoal) pushToRecent(entry.key, msg)
        // F1 Wave 3: emit a version marker every APPLY_MARKER_INTERVAL rows so
        // the scrubber has a discrete time axis. We latch the msg's
        // match_time_ms so the marker records "where were we in the match at
        // hyperbee version V". The very first row always seeds a marker so
        // the earliest scrub target is anchored at kickoff.
        markerNodeCounter += 1
        if (typeof msg?.match_time_ms === 'number') {
          lastAppliedMatchTimeMs = msg.match_time_ms
        }
        if (typeof msg?.wall_clock_ms === 'number') {
          lastAppliedWallClockMs = msg.wall_clock_ms
        }
        if (markerNodeCounter === 1 || markerNodeCounter % APPLY_MARKER_INTERVAL === 0) {
          const v = base.view?.version
          if (typeof v === 'number' && v > 0) {
            pushVersionMarker(v, lastAppliedMatchTimeMs, lastAppliedWallClockMs)
          }
        }
        for (const cb of messageListeners) {
          try { cb(msg) } catch (err) {
            console.log('[Curva] chat listener threw:', err?.message)
          }
        }
      }
    }

    // Post-batch: always try to publish a tail marker at the current view
    // version. This is a no-op if lastMarkerVersion is already at the tip
    // (pushVersionMarker guards against regressions). Ensures the LAST row
    // ever applied is always reachable via the scrubber even if it isn't on
    // an APPLY_MARKER_INTERVAL boundary.
    if (markerNodeCounter > 0) {
      const v = base.view?.version
      if (typeof v === 'number' && v > 0) {
        pushVersionMarker(v, lastAppliedMatchTimeMs, lastAppliedWallClockMs)
      }
    }

    detectCluster()
  }

  function pushToRecent(key, msg) {
    recentWindow.push({
      key,
      wall_clock_ms: msg.wall_clock_ms,
      match_time_ms: msg.match_time_ms
    })
    while (recentWindow.length > RECENT_WINDOW_SIZE) recentWindow.shift()
  }

  function detectCluster() {
    if (recentWindow.length < GOAL_CLUSTER_COUNT) return
    const now = recentWindow[recentWindow.length - 1].wall_clock_ms
    const cutoff = now - GOAL_CLUSTER_WINDOW_MS
    const within = recentWindow.filter((r) => r.wall_clock_ms >= cutoff)
    if (within.length < GOAL_CLUSTER_COUNT) return
    const messageIds = within.map((r) => r.key)
    // Dedupe: a cluster is identified by the set of keys.
    const clusterId = messageIds.join('|')
    if (clustersEmitted.has(clusterId)) return
    clustersEmitted.add(clusterId)
    // Cap dedupe set so it doesn't grow forever.
    if (clustersEmitted.size > 128) {
      const first = clustersEmitted.values().next().value
      clustersEmitted.delete(first)
    }
    const payload = {
      matchTimeMs: within[Math.floor(within.length / 2)].match_time_ms,
      messageIds,
      count: within.length,
      windowMs: GOAL_CLUSTER_WINDOW_MS
    }
    for (const cb of clusterListeners) {
      try { cb(payload) } catch (err) {
        console.log('[Curva] chat cluster listener threw:', err?.message)
      }
    }
  }

  base.on('update', () => { emitNew() })

  /**
   * Append a system message directly to the Autobase. Currently used by the
   * tip service to announce a confirmed tip (type: 'system:tip'). Rate-limits
   * still apply on the reducer side so a malicious peer cannot flood system
   * messages by re-sending the same shape.
   *
   * @param {object} msg  must include `type` and pass isValidMessage()
   */
  async function sendSystem(msg) {
    if (!msg || typeof msg !== 'object') throw new TypeError('msg required')
    const enriched = {
      by_peer: myPubkey,
      match_time_ms: 0,
      wall_clock_ms: Date.now(),
      ...msg
    }
    if (!isValidMessage(enriched)) {
      throw new RangeError('sendSystem: message failed validation for type ' + msg.type)
    }
    // Fix Wave A T2: rate-limit gate at ingress, matching pre-fix semantics.
    // Only OPTIMISTIC (non-writer) appends are rate-limited; the local writer
    // path is trusted. This preserves throughput for the host (who is always
    // writable) and prevents apply() from mutating closure state on rebase.
    const isOptimistic = !base.writable
    if (isOptimistic && !withinRate(myPubkey)) {
      const err = new Error('chat rate limit exceeded')
      err.code = 'RATE_LIMITED'
      throw err
    }
    if (base.writable) {
      await base.append(enriched)
    } else {
      await base.append(enriched, { optimistic: true })
    }
    // ADR-004: immediate foreground ack after a local writer append so the
    // head reference is not delayed by the 2500ms background timer. No-op on
    // non-indexers (base.ackable is false). Best-effort — a failed ack does
    // not roll back the append.
    try { if (base.ackable) await base.ack(false) } catch { /* noop */ }
    return enriched
  }

  async function send({ text, match_time_ms, lang, source_lang }) {
    if (typeof text !== 'string') throw new TypeError('text must be a string')
    const cleaned = sanitizeText(text)
    if (cleaned.length === 0) throw new RangeError('text is empty after sanitization')

    if (typeof match_time_ms !== 'number' || match_time_ms < 0) {
      throw new RangeError('match_time_ms must be a non-negative number')
    }

    const msg = {
      type: 'msg',
      text: cleaned,
      by_peer: myPubkey,
      match_time_ms: Math.floor(match_time_ms),
      wall_clock_ms: Date.now()
    }
    // Phase 3.5: source_lang for translation. Backward compat: accept the
    // pre-3.5 `lang` field too. Both are stored under `source_lang` (new
    // canonical name) AND `lang` (legacy field) so old peers keep parsing.
    const chosen = normalizeLang(source_lang) || normalizeLang(lang)
    if (chosen) {
      msg.source_lang = chosen
      msg.lang = chosen // legacy compat
    }

    // Fix Wave A T2: rate-limit gate at ingress, matching pre-fix semantics.
    // Only OPTIMISTIC (non-writer) appends are rate-limited; the local writer
    // path is trusted. This preserves throughput for the host and prevents
    // apply() from mutating closure state on rebase (see holepunchto/autobase
    // - apply must be deterministic).
    const isOptimistic = !base.writable
    if (isOptimistic && !withinRate(myPubkey)) {
      const err = new Error('chat rate limit exceeded')
      err.code = 'RATE_LIMITED'
      throw err
    }

    // Wave 7 T1: if we're an accepted writer (base.writable) we append
    // non-optimistically; otherwise fall back to optimistic (Pattern A path
    // via host ackWriter). This keeps host-offline resilience.
    if (base.writable) {
      await base.append(msg)
    } else {
      await base.append(msg, { optimistic: true })
    }
    // ADR-004: post-append immediate ack so a live indexer converges peers
    // without waiting for the periodic timer.
    try { if (base.ackable) await base.ack(false) } catch { /* noop */ }
    return msg
  }

  async function history({ from = 0, limit = 100, at } = {}) {
    const gtKey = 'chat/' + String(from).padStart(16, '0') + '/'
    const out = []
    // F1 Wave 3: when `at` is a positive integer we read from a hyperbee
    // checkout instead of the live view. This lets the renderer replay the
    // room state at Autobase version N without racing new appends. The
    // checkout is short-lived and released to GC as soon as the read stream
    // finishes; snapshotting the core is cheap because hypercore snapshots
    // hold a lightweight length reference (verified: hyperbee/index.js:770
    // uses core.snapshot() which does not clone blocks).
    const useView = (typeof at === 'number' && Number.isFinite(at) && at > 0)
      ? base.view.checkout(Math.floor(at))
      : base.view
    try {
      const stream = useView.createReadStream({
        gt: gtKey,
        lt: 'chat0',
        limit
      })
      for await (const entry of stream) {
        out.push(entry.value)
      }
    } catch (err) {
      console.log('[Curva] chat history failed:', err?.message)
    }
    return out
  }

  // F1 Wave 3: read-only checkout handle. Wrap the hyperbee snapshot so callers
  // that try to mutate (put/del/batch) get a CheckoutReadOnly error at ingress
  // instead of relying on hypercore's internal read-only enforcement. The
  // exposed surface is intentionally minimal: `history` + `listGoals` cover
  // every renderer read path today; `getBase` returns null so no writer path
  // is reachable through the handle.
  function checkoutAt(version) {
    if (typeof version !== 'number' || !Number.isFinite(version) || version <= 0) {
      throw new RangeError('checkoutAt: version must be a positive integer')
    }
    const v = Math.floor(version)
    const snapshot = base.view.checkout(v)

    function refuseWrite() {
      throw new CheckoutReadOnly('checkout is read-only (Autobase view snapshot at version ' + v + ')')
    }

    async function historyAt({ from = 0, limit = 100 } = {}) {
      const gtKey = 'chat/' + String(from).padStart(16, '0') + '/'
      const out = []
      try {
        const stream = snapshot.createReadStream({
          gt: gtKey,
          lt: 'chat0',
          limit
        })
        for await (const entry of stream) out.push(entry.value)
      } catch (err) {
        console.log('[Curva] chat history (checkout) failed:', err?.message)
      }
      return out
    }

    async function listGoalsAt({ fromMinute = 0, toMinute = MAX_GOAL_MINUTE, limit = 500 } = {}) {
      const fromN = Math.max(0, Math.min(MAX_GOAL_MINUTE, fromMinute | 0))
      const toN = Math.max(fromN, Math.min(MAX_GOAL_MINUTE, toMinute | 0))
      const gte = `match/goals/${paddedMinute(fromN)}/`
      const lt = toN >= MAX_GOAL_MINUTE
        ? 'match/goals0'
        : `match/goals/${paddedMinute(toN + 1)}/`
      const out = []
      try {
        const stream = snapshot.createReadStream({ gte, lt, limit })
        for await (const entry of stream) out.push(entry.value)
      } catch (err) {
        console.log('[Curva] chat listGoals (checkout) failed:', err?.message)
      }
      return out
    }

    return {
      version: v,
      history: historyAt,
      listGoals: listGoalsAt,
      // Write surface stubs: every mutation path routes to refuseWrite() so a
      // caller that accidentally uses the checkout handle in a write context
      // fails loudly at the ingress rather than corrupting state.
      send: refuseWrite,
      sendSystem: refuseWrite,
      appendGoal: refuseWrite,
      close: async () => {
        try { await snapshot.close?.() } catch { /* noop */ }
      }
    }
  }

  // F1 Wave 3: return recent version markers so the renderer can build a
  // scrubber timeline. The list is sorted ascending by version. When `limit`
  // is passed we return the TAIL (latest N) so the initial UI paints the
  // most recent match time without walking a long tail.
  function getVersions({ limit = 32 } = {}) {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
      throw new RangeError('getVersions: limit must be a positive integer')
    }
    const n = Math.min(Math.floor(limit), versionMarkers.length)
    return versionMarkers.slice(-n).map((m) => ({ ...m }))
  }

  function onVersionMarker(cb) {
    if (typeof cb !== 'function') throw new TypeError('onVersionMarker requires a function')
    versionMarkerListeners.add(cb)
    return () => versionMarkerListeners.delete(cb)
  }

  function onMessage(cb) {
    if (typeof cb !== 'function') throw new TypeError('onMessage requires a function')
    messageListeners.add(cb)
    return () => messageListeners.delete(cb)
  }

  function onGoalCluster(cb) {
    if (typeof cb !== 'function') throw new TypeError('onGoalCluster requires a function')
    clusterListeners.add(cb)
    return () => clusterListeners.delete(cb)
  }

  // F3: host-only goal append. Writes `system:goal` to the autobase; apply()
  // enforces the host-only gate so a non-host optimistic append is silently
  // dropped by every peer's reducer. `goalId` is deterministic (stable hash
  // of matchId + minute + scorer + team) so autobase rebase re-executes the
  // identical put — idempotent under replay.
  async function appendGoal({ minute, goalId, scorer, team, score, matchId }) {
    if (typeof matchId !== 'string' || matchId.length === 0) {
      throw new RangeError('appendGoal: matchId required')
    }
    if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > MAX_GOAL_MINUTE) {
      throw new RangeError('appendGoal: minute must be integer 0..' + MAX_GOAL_MINUTE)
    }
    if (team !== 'home' && team !== 'away') {
      throw new RangeError("appendGoal: team must be 'home' or 'away'")
    }
    if (!score || typeof score !== 'object') {
      throw new RangeError('appendGoal: score required')
    }
    const homeScore = score.home | 0
    const awayScore = score.away | 0
    if (homeScore < 0 || homeScore > 30 || awayScore < 0 || awayScore > 30) {
      throw new RangeError('appendGoal: score out of range')
    }
    // Derive a stable goalId if not supplied. Deterministic so rebase replays
    // identical bytes. Caller may pass one explicitly (e.g. from the backend
    // SSE payload) but if omitted, we hash the identifying tuple.
    const scorerClean = typeof scorer === 'string' ? scorer.slice(0, SCORER_MAX_LEN) : null
    const derivedGoalId = typeof goalId === 'string' && goalId.length > 0
      ? goalId.slice(0, GOAL_ID_MAX_LEN)
      : stableGoalId({ matchId, minute, scorer: scorerClean, team })

    const enriched = {
      type: 'system:goal',
      by_peer: myPubkey,
      match_time_ms: minute * 60_000,
      wall_clock_ms: Date.now(),
      matchId: matchId.slice(0, MATCH_ID_MAX_LEN),
      goalId: derivedGoalId,
      minute,
      team,
      homeScore,
      awayScore,
      scorer: scorerClean
    }
    if (!isValidMessage(enriched)) {
      throw new RangeError('appendGoal: enriched payload failed validation')
    }
    // Rate-limit gate is not applied here: goal events are host-authoritative
    // and low-frequency (worst-case ~10/match). Rate limiting protects against
    // chat spam from optimistic peers; the host writer path is trusted.
    if (base.writable) {
      await base.append(enriched)
    } else {
      await base.append(enriched, { optimistic: true })
    }
    // ADR-004: immediate post-append ack. Goals are host-authoritative and
    // low-frequency; converging peers as fast as possible on a goal event is
    // the whole point of the F3 shard.
    try { if (base.ackable) await base.ack(false) } catch { /* noop */ }
    return enriched
  }

  // F3: read goals in minute order. Uses createReadStream({gte, lt}) on the
  // root bee. Docs-verified range API.
  async function listGoals({ fromMinute = 0, toMinute = MAX_GOAL_MINUTE, limit = 500 } = {}) {
    const fromN = Math.max(0, Math.min(MAX_GOAL_MINUTE, fromMinute | 0))
    const toN = Math.max(fromN, Math.min(MAX_GOAL_MINUTE, toMinute | 0))
    const gte = `match/goals/${paddedMinute(fromN)}/`
    // Upper bound: use the padded (toN+1) prefix. When toN === MAX_GOAL_MINUTE
    // we fall through to the 'match/goals0' sentinel so the top of the range
    // is not clipped.
    const lt = toN >= MAX_GOAL_MINUTE
      ? 'match/goals0'
      : `match/goals/${paddedMinute(toN + 1)}/`
    const out = []
    try {
      const stream = base.view.createReadStream({ gte, lt, limit })
      for await (const entry of stream) out.push(entry.value)
    } catch (err) {
      console.log('[Curva] chat listGoals failed:', err?.message)
    }
    return out
  }

  async function close() {
    messageListeners.clear()
    clusterListeners.clear()
    versionMarkerListeners.clear()
    try { await base.close() } catch { /* noop */ }
  }

  // Wave 7 T1: host publishes its writer pubkey once it's known so the reducer
  // can validate system message authorship. Called from room.js right after
  // openRoom() when isHost is true. Peers learn hostWriterHex from a small
  // 'room/host-writer' Hyperbee entry that room.js replicates.
  function setHostWriter(hex) {
    if (typeof hex !== 'string' || hex.length === 0) return
    hostWriterHex = hex.toLowerCase()
  }

  function isAuthorizedTipAck(writerHex) {
    if (!hostWriterHex) return true // pre-init grace: cannot enforce yet
    return writerHex === hostWriterHex
  }

  // Wave 10: Host-only gate for `system:pool-opened`, `system:match-result`,
  // and `system:pool-payout`. Identical logic to isAuthorizedTipAck but
  // named for grep-ability. Kept separate so future changes to one class
  // don't accidentally affect the other.
  function isAuthorizedHostSystem(writerHex) {
    if (!hostWriterHex) return true
    return writerHex === hostWriterHex
  }

  // Fix Wave A T2: view-aware variants used inside apply(). Reads the
  // tip-writer binding directly from the Hyperbee view instead of a mutable
  // closure Map, so apply() stays pure and rebase-safe.
  async function isAuthorizedSystemTipView(view, writerHex, v) {
    if (!hostWriterHex) return true
    if (writerHex === hostWriterHex) return true
    if (typeof v?.tx_hash === 'string') {
      const existing = await readTxWriter(view, v.tx_hash)
      if (!existing) return true
      return existing === writerHex
    }
    return false
  }

  async function isAuthorizedTipCongratsView(view, writerHex, v) {
    if (!hostWriterHex) return true
    if (writerHex === hostWriterHex) return true
    if (typeof v?.tx_hash === 'string') {
      const existing = await readTxWriter(view, v.tx_hash)
      return existing === writerHex
    }
    return false
  }

  return {
    send,
    sendSystem,
    appendGoal,
    listGoals,
    history,
    // F1 Wave 3 scrubber surface.
    checkoutAt,
    getVersions,
    onVersionMarker,
    onMessage,
    onGoalCluster,
    getBase: () => base,
    setHostWriter,
    // Wave 8A: room.js wires this on successful Pattern B addWriter so the
    // reducer accepts system:tip messages from promoted writers WITHOUT
    // relaxing the host-only gate on system:tip-ack.
    addAuthorizedWriter,
    isAuthorizedWriter,
    // Spectator tier surface. room.js calls these when a reader-tier peer is
    // admitted (add) or promoted to writer (remove). isReaderKey is exposed
    // for the brittle tests + renderer-side badging.
    addReaderKey,
    removeReaderKey,
    isReaderKey,
    getWriterKey: () => (base.local && base.local.key) ? base.local.key.toString('hex') : null,
    close
  }
}

// -- helpers ---------------------------------------------------------------

// F3 Hyperbee goal shard helpers.
//
// paddedMinute: 3-digit zero-padded string so lex order matches numeric order
// across the full 0..130 range (regulation + knockout extra time). Values
// outside the range are clamped.
function paddedMinute(m) {
  const n = Number.isFinite(m) ? Math.floor(m) : 0
  const clamped = Math.max(0, Math.min(MAX_GOAL_MINUTE, n))
  return String(clamped).padStart(3, '0')
}

// goalKey: `match/goals/<paddedMinute>/<goalId>`. goalId is sanitized to a
// filesystem-ish charset so no separators leak into the key layout.
function goalKey(msg) {
  const min = paddedMinute(msg.minute)
  const gid = String(msg.goalId || 'goal').slice(0, GOAL_ID_MAX_LEN).replace(/[^a-zA-Z0-9_-]/g, '')
  return `match/goals/${min}/${gid || 'goal'}`
}

// stableGoalId: deterministic identifier for a scored goal, derived from the
// (matchId, minute, scorer, team) tuple. Used when the caller does not supply
// an explicit goalId. Stable across autobase rebases so replay writes the
// same key. FNV-1a 32-bit hash + short suffix keeps the id URL-safe and
// bounded to 16 chars.
function stableGoalId({ matchId, minute, scorer, team }) {
  const raw = String(matchId) + '|' + minute + '|' + (scorer || 'unknown') + '|' + team
  let hash = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  const suffix = (scorer || 'x').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'x'
  return `g${hash.toString(16).padStart(8, '0')}-${suffix}`
}

// F3: shape validator for `system:goal`. Strict per-field checks so a forged
// Autobase append cannot slip past the host-only writer gate by wrapping
// garbage in the known `type` string.
function isValidSystemGoal(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:goal') return false
  if (typeof v.by_peer !== 'string' || v.by_peer.length === 0) return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.matchId !== 'string' || v.matchId.length === 0 || v.matchId.length > MATCH_ID_MAX_LEN) return false
  if (typeof v.goalId !== 'string' || v.goalId.length === 0 || v.goalId.length > GOAL_ID_MAX_LEN) return false
  if (typeof v.minute !== 'number' || !Number.isInteger(v.minute) || v.minute < 0 || v.minute > MAX_GOAL_MINUTE) return false
  if (v.team !== 'home' && v.team !== 'away') return false
  if (typeof v.homeScore !== 'number' || !Number.isInteger(v.homeScore) || v.homeScore < 0 || v.homeScore > 30) return false
  if (typeof v.awayScore !== 'number' || !Number.isInteger(v.awayScore) || v.awayScore < 0 || v.awayScore > 30) return false
  if (v.scorer !== null && (typeof v.scorer !== 'string' || v.scorer.length > SCORER_MAX_LEN)) return false
  return true
}

function chatKey(msg) {
  // F3: `system:goal` is stored under the `match/goals/<paddedMinute>/<goalId>`
  // shard, NOT under `chat/*`. Return the goal shard key so the apply()
  // reducer's `view.put(key, v)` dispatches to the correct root-bee slot. The
  // renderer differentiates by `msg.type === 'system:goal'`.
  if (msg?.type === 'system:goal') {
    return goalKey(msg)
  }
  const ts = String(msg.wall_clock_ms).padStart(16, '0')
  // For system messages, use a tx-hash suffix (when available) so multiple
  // system:tip announcements in the same millisecond disambiguate. For
  // regular msgs, keep the pre-existing 8-char peer suffix so the DOM
  // key convention on the renderer side stays stable.
  if (msg?.type === 'system:tip' && typeof msg.tx_hash === 'string') {
    return `chat/${ts}/tip-${msg.tx_hash.slice(2, 10)}`
  }
  if (msg?.type === 'system:tip-congrats' && typeof msg.tx_hash === 'string') {
    return `chat/${ts}/cgt-${msg.tx_hash.slice(2, 10)}`
  }
  if (msg?.type === 'system:tip-congrats') {
    return `chat/${ts}/cgt-${(msg.by_peer || 'anon').slice(0, 8)}`
  }
  if (msg?.type === 'system:tip-ack' && typeof msg.tx_hash === 'string') {
    return `chat/${ts}/ack-${msg.tx_hash.slice(2, 10)}`
  }
  // Wave 13A: host-only AI commentary. Suffix uses the millisecond timestamp
  // (already in ts) plus a short trigger tag so multiple commentaries in the
  // same wall-clock ms disambiguate. Idempotent on rebase because the
  // (ts, trigger) pair is derived from the message body itself.
  if (msg?.type === 'system:commentary') {
    const trig = typeof msg.trigger === 'string' && msg.trigger.length > 0
      ? msg.trigger.slice(0, 12).replace(/[^a-z0-9-]/gi, '')
      : 'tick'
    return `chat/${ts}/cmt-${trig || 'tick'}`
  }
  // Wave 13B: bot-query + bot-reply keyed by their shared query_id so a rebase
  // that replays the same node writes an identical bee key (idempotent). We
  // slice to 12 chars to keep the key compact; collision within a single ms
  // is negligible given the query_id contains a millisecond + 6-digit random.
  if (msg?.type === 'system:bot-query' && typeof msg.query_id === 'string') {
    const qid = msg.query_id.replace(/[^a-z0-9_-]/gi, '').slice(0, 12) || 'q'
    return `chat/${ts}/bq-${qid}`
  }
  if (msg?.type === 'system:bot-reply' && typeof msg.query_id === 'string') {
    const qid = msg.query_id.replace(/[^a-z0-9_-]/gi, '').slice(0, 12) || 'q'
    return `chat/${ts}/br-${qid}`
  }
  // Wave 14: attendance-issued keyed by peer address so multiple issuances
  // for the same peer in the same wall-clock ms collapse to a single row
  // (idempotent replay).
  if (msg?.type === 'system:attendance-issued' && typeof msg.peerAddress === 'string') {
    return `chat/${ts}/att-${msg.peerAddress.slice(2, 10).toLowerCase()}`
  }
  // Wave 10 host-only pool lifecycle messages. Use a stable per-payload
  // suffix so idempotent replay writes the same Hyperbee key.
  if (msg?.type === 'system:pool-opened' && typeof msg.matchId === 'string') {
    return `chat/${ts}/pool-open-${String(msg.matchId).slice(0, 8)}`
  }
  if (msg?.type === 'system:match-result' && typeof msg.matchId === 'string') {
    return `chat/${ts}/pool-res-${String(msg.matchId).slice(0, 8)}`
  }
  if (msg?.type === 'system:pool-payout' && typeof msg.txHash === 'string') {
    return `chat/${ts}/pool-pay-${msg.txHash.slice(2, 10)}`
  }
  // Spectator tier: system:reader-joined is keyed on the reader hex so the
  // same admission replayed by a rebasing peer collapses to a single row.
  if (msg?.type === 'system:reader-joined' && typeof msg.readerHex === 'string') {
    return `chat/${ts}/reader-${msg.readerHex.slice(0, 8)}`
  }
  const suffix = (msg.by_peer || 'anon').slice(0, 8)
  return `chat/${ts}/${suffix}`
}

function sanitizeText(text) {
  // Strip C0 control chars (keep space, keep newline as space), C1 (0x80-0x9F),
  // and BOM. Then collapse whitespace and trim.
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code === 0x0A || code === 0x0D || code === 0x09) {
      out += ' '
      continue
    }
    if (code < 0x20) continue // C0
    if (code >= 0x80 && code <= 0x9F) continue // C1
    if (code === 0xFEFF) continue // BOM
    out += ch
  }
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS)
  return out
}

// Phase 3.5: normalize a lang code to a lowercase 2-letter form. Rejects
// non-strings, empty strings, and out-of-range lengths. Returns null for
// anything invalid so callers can fall through to defaults.
function normalizeLang(x) {
  if (typeof x !== 'string') return null
  const trimmed = x.trim().toLowerCase()
  if (trimmed.length < 2 || trimmed.length > 8) return null
  return trimmed
}

// Phase 3.5: read the source language of a stored message, with fallback to
// the legacy `lang` field and finally to a caller-provided default.
function readSourceLang(msg, fallback = 'en') {
  if (!msg || typeof msg !== 'object') return fallback
  const cand = normalizeLang(msg.source_lang) || normalizeLang(msg.lang)
  return cand || fallback
}

function isValidMessage(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type === 'system:tip') return isValidSystemTip(v)
  if (v.type === 'system:tip-congrats') return isValidSystemTipCongrats(v)
  if (v.type === 'system:tip-ack') return isValidSystemTipAck(v)
  // Wave 10: host-only pool lifecycle messages. Writer-hex gate lives in
  // apply(); the shape validators are pure and used both places.
  if (v.type === 'system:pool-opened') return isValidSystemPoolOpened(v)
  if (v.type === 'system:match-result') return isValidSystemMatchResult(v)
  if (v.type === 'system:pool-payout') return isValidSystemPoolPayout(v)
  // Wave 13A shape validator. Kept adjacent to the pool-lifecycle validators
  // so the authorship-gate + shape-check pair is co-located.
  if (v.type === 'system:commentary') return isValidSystemCommentary(v)
  // Wave 15/CupFinal: on-device coach + VLM + OCR system pills. Peer-writer
  // allowed (each peer authors from its own local model output).
  if (v.type === 'system:coach') return isValidSystemCoach(v)
  if (v.type === 'system:vlm-caption') return isValidSystemVlmCaption(v)
  if (v.type === 'system:ocr-read') return isValidSystemOcrRead(v)
  // Wave 3: ask-the-frame answer + goal-card structured extract. Peer-writer
  // allowed for both since they represent local on-device model output.
  if (v.type === 'system:ask-frame-answer') return isValidSystemAskFrameAnswer(v)
  if (v.type === 'system:goal-card') return isValidSystemGoalCard(v)
  // Wave 13B: `/bot` roomBot query + reply. Peer-writer allowed for both
  // (any peer can ask the bot; any peer that runs the bot can reply). The
  // reducer applies a host-only gate on `system:bot-reply` when the host is
  // the sole bot operator; see apply() below.
  if (v.type === 'system:bot-query') return isValidSystemBotQuery(v)
  if (v.type === 'system:bot-reply') return isValidSystemBotReply(v)
  // Wave 14: attendance-issued shape validator. Strict per-field checks so a
  // forged Autobase append cannot slip past the host-only writer gate by
  // wrapping garbage in the known `type` string.
  if (v.type === 'system:attendance-issued') return isValidSystemAttendanceIssued(v)
  // F3: system:goal shape validator. Host-only in apply(); shape check here
  // is pure so it can also be exercised directly by the brittle test suite.
  if (v.type === 'system:goal') return isValidSystemGoal(v)
  // D2 demo-mode prediction pills. system:prediction-stake is peer-writer
  // allowed (any peer stakes for themselves). system:prediction-settle is
  // host-only in apply(). Shape validators are pure so brittle tests can
  // exercise them without spinning up autobase.
  if (v.type === 'system:prediction-stake') return isValidSystemPredictionStake(v)
  if (v.type === 'system:prediction-settle') return isValidSystemPredictionSettle(v)
  // Spectator tier: system:reader-joined is a host-broadcast roster update.
  if (v.type === 'system:reader-joined') return isValidSystemReaderJoined(v)
  if (v.type !== 'msg') return false
  if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > MAX_CHARS) return false
  if (typeof v.by_peer !== 'string') return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  // Tier 4 Round 2: optional keet-identity attestation. Legacy messages omit
  // the field and still validate; the reader marks them "unverified". When the
  // field is present it must be lowercase-ish hex 130-4096 chars.
  if (!isValidIdentityProof(v.identity_proof)) return false
  return true
}

// Tier 4 Round 2: shared validator for the optional `identity_proof` field on
// `msg`, `system:tip`, and `system:attendance-issued`. Accepts `undefined` and
// `null` (legacy shape) but rejects malformed non-null values so a forged
// append cannot slip garbage past the type gate.
//
// keet-identity-key@3.2.0 encodes ProofEncoding with compact-encoding; the
// smallest well-formed bootstrap+attestData proof is ~65 bytes signed material
// plus framing, so 130 hex chars is a safe floor. 4096 is the practical ceiling
// for a device chain of any realistic depth.
function isValidIdentityProof(v) {
  if (v === undefined || v === null) return true
  if (typeof v !== 'string') return false
  if (v.length < 130 || v.length > 4096) return false
  if (!/^[0-9a-fA-F]+$/.test(v)) return false
  return true
}

// Wave 6 T14: `system:tip-ack` is a host-signed EIP-191 receipt for a
// confirmed tip. Signature + signer are public; any peer can ecrecover.
function isValidSystemTipAck(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:tip-ack') return false
  if (typeof v.by_peer !== 'string') return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v.tx_hash)) return false
  if (typeof v.signature !== 'string' || v.signature.length < 130 || v.signature.length > 200) return false
  if (typeof v.signer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v.signer)) return false
  if (v.text !== undefined && (typeof v.text !== 'string' || v.text.length > 512)) return false
  return true
}

// Wave 6 T4: `system:tip-congrats` announces a tip in a translatable body
// so QVAC translates it into every viewer's language. Emitted right after
// the corresponding `system:tip` by the tipper.
function isValidSystemTipCongrats(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:tip-congrats') return false
  if (typeof v.by_peer !== 'string') return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > MAX_CHARS) return false
  if (v.lang !== undefined && (typeof v.lang !== 'string' || v.lang.length > 8)) return false
  if (v.source_lang !== undefined && (typeof v.source_lang !== 'string' || v.source_lang.length > 8)) return false
  if (v.tx_hash !== undefined && (typeof v.tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v.tx_hash))) return false
  return true
}

// Task 6: system tip message shape. Emitted by the tipper on successful
// facilitator submission. Fields are typed strictly so peers cannot craft
// a fake tip announcement with an amount larger than the demo cap.
function isValidSystemTip(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:tip') return false
  if (typeof v.by_peer !== 'string') return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.amount !== 'string' || !/^[0-9]{1,32}$/.test(v.amount)) return false
  if (typeof v.tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v.tx_hash)) return false
  if (v.explorer_url !== undefined && (typeof v.explorer_url !== 'string' || v.explorer_url.length > 512)) return false
  if (v.to_host !== undefined && (typeof v.to_host !== 'string' || v.to_host.length > 128)) return false
  if (v.from_handle !== undefined && (typeof v.from_handle !== 'string' || v.from_handle.length > 64)) return false
  // Tier 4 Round 2: optional keet-identity attestation. Legacy tips validate
  // without it; new tips SHOULD include it when the feature flag is on.
  if (!isValidIdentityProof(v.identity_proof)) return false
  return true
}

// Wave 10: shape validators for host-only prediction-pool lifecycle messages.
// Deliberately strict: unknown or malformed shapes get dropped by isValidMessage
// so a forged Autobase append cannot slip past the host-only writer gate by
// wrapping garbage in a known `type` string.
function isValidSystemPoolOpened(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:pool-opened') return false
  if (typeof v.by_peer !== 'string') return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.matchId !== 'string' || v.matchId.length === 0 || v.matchId.length > 64) return false
  if (typeof v.poolAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v.poolAddress)) return false
  if (typeof v.stakeToken !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v.stakeToken)) return false
  if (typeof v.entryStakeAtomic !== 'string' || !/^[0-9]+$/.test(v.entryStakeAtomic)) return false
  if (v.mode !== 'winner-only' && v.mode !== 'exact-score') return false
  if (typeof v.deadlineMs !== 'number' || v.deadlineMs <= 0) return false
  return true
}

function isValidSystemMatchResult(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:match-result') return false
  if (typeof v.by_peer !== 'string') return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.matchId !== 'string' || v.matchId.length === 0 || v.matchId.length > 64) return false
  if (v.winner !== 'HOME' && v.winner !== 'AWAY' && v.winner !== 'DRAW') return false
  if (typeof v.homeGoals !== 'number' || !Number.isInteger(v.homeGoals) || v.homeGoals < 0 || v.homeGoals > 30) return false
  if (typeof v.awayGoals !== 'number' || !Number.isInteger(v.awayGoals) || v.awayGoals < 0 || v.awayGoals > 30) return false
  return true
}

function isValidSystemPoolPayout(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:pool-payout') return false
  if (typeof v.by_peer !== 'string') return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.matchId !== 'string' || v.matchId.length === 0 || v.matchId.length > 64) return false
  if (typeof v.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v.txHash)) return false
  if (typeof v.toAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v.toAddress)) return false
  if (typeof v.amountAtomic !== 'string' || !/^[0-9]+$/.test(v.amountAtomic)) return false
  if (v.route !== undefined && v.route !== 'erc20-transfer' && v.route !== 'refund') return false
  return true
}

// Wave 14: shape validator for `system:attendance-issued`. All addresses are
// lowercased 0x + 40-char hex; signature is a 65-byte hex string per EIP-191.
// matchId is optional and capped at 64 chars.
function isValidSystemAttendanceIssued(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:attendance-issued') return false
  if (typeof v.by_peer !== 'string' || v.by_peer.length === 0) return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.peerAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v.peerAddress)) return false
  if (typeof v.hostAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v.hostAddress)) return false
  if (typeof v.issuedAt !== 'number' || !Number.isFinite(v.issuedAt) || v.issuedAt <= 0) return false
  if (typeof v.signature !== 'string' || !/^0x[0-9a-fA-F]{130,132}$/.test(v.signature)) return false
  if (v.matchId !== undefined && v.matchId !== null && (typeof v.matchId !== 'string' || v.matchId.length > 64)) return false
  // Tier 4 Round 2: optional keet-identity attestation. Host attests when the
  // feature flag is on; legacy passes without the field still validate.
  if (!isValidIdentityProof(v.identity_proof)) return false
  return true
}

// D2 demo mode: shape validator for `system:prediction-stake`. Any peer can
// stake for themselves, so this is NOT host-only in apply(). The peer's
// `peerAddress` is lower-hex to key against the wallet that authorized the
// EIP-3009 entry. `stakeAtomic` is stringified USDT atomic (6-decimal).
// `txHash` is optional because the facilitator relay may still be pending
// when the pill is broadcast.
function isValidSystemPredictionStake(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:prediction-stake') return false
  if (typeof v.by_peer !== 'string' || v.by_peer.length === 0) return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.peerHandle !== 'string' || v.peerHandle.length === 0 || v.peerHandle.length > 64) return false
  if (v.winner !== 'HOME' && v.winner !== 'AWAY' && v.winner !== 'DRAW') return false
  if (v.homeGoals !== undefined && (typeof v.homeGoals !== 'number' || !Number.isInteger(v.homeGoals) || v.homeGoals < 0 || v.homeGoals > 30)) return false
  if (v.awayGoals !== undefined && (typeof v.awayGoals !== 'number' || !Number.isInteger(v.awayGoals) || v.awayGoals < 0 || v.awayGoals > 30)) return false
  if (typeof v.stakeAtomic !== 'string' || !/^[0-9]+$/.test(v.stakeAtomic)) return false
  if (v.txHash !== undefined && v.txHash !== null && (typeof v.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v.txHash))) return false
  return true
}

// D2 demo mode: shape validator for `system:prediction-settle`. Host-only in
// apply(). Renderer keys on `outcome === 'won'` for the winner banner; if the
// field is absent the renderer defaults to the loser path (fail-safe).
// `winners` and `losers` are lists of lowercased 0x + 40-char hex addresses.
function isValidSystemPredictionSettle(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:prediction-settle') return false
  if (typeof v.by_peer !== 'string' || v.by_peer.length === 0) return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (v.poolId !== undefined && v.poolId !== null && (typeof v.poolId !== 'string' || v.poolId.length > 128)) return false
  if (v.matchId !== undefined && v.matchId !== null && (typeof v.matchId !== 'string' || v.matchId.length > 64)) return false
  if (!Array.isArray(v.winners) || v.winners.length > 32) return false
  if (!Array.isArray(v.losers) || v.losers.length > 32) return false
  for (const addr of v.winners) {
    if (typeof addr !== 'string' || !/^0x[0-9a-f]{40}$/.test(addr)) return false
  }
  for (const addr of v.losers) {
    if (typeof addr !== 'string' || !/^0x[0-9a-f]{40}$/.test(addr)) return false
  }
  if (v.tx !== undefined && v.tx !== null && (typeof v.tx !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v.tx))) return false
  if (v.payoutAtomic !== undefined && v.payoutAtomic !== null && (typeof v.payoutAtomic !== 'string' || !/^[0-9]+$/.test(v.payoutAtomic))) return false
  return true
}

// Spectator tier: shape validator for `system:reader-joined`. Emitted by the
// host when a reader-tier invitation is admitted. `readerHex` is the chat
// writer-key hex of the newly admitted reader, so downstream renderers can
// display the roster diff without waiting for the next roomState scan.
// Strict: 64-char lowercase hex string; matches the shape we persist under
// `room/tier-map/<hex>`.
function isValidSystemReaderJoined(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:reader-joined') return false
  if (typeof v.by_peer !== 'string' || v.by_peer.length === 0) return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.readerHex !== 'string' || !/^[0-9a-f]{64}$/.test(v.readerHex)) return false
  return true
}

// Wave 13A: shape validator for `system:commentary` (QVAC LLM output).
// Strict per-field checks so a forged Autobase append cannot slip past the
// host-only writer gate by wrapping garbage in the known `type` string. Text
// cap mirrors MAX_CHARS (280) so the chat DOM row cap still holds.
function isValidSystemCommentary(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:commentary') return false
  if (typeof v.by_peer !== 'string' || v.by_peer.length === 0) return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > MAX_CHARS) return false
  if (v.tone !== undefined && (typeof v.tone !== 'string' || v.tone.length > 32)) return false
  if (v.trigger !== undefined && (typeof v.trigger !== 'string' || v.trigger.length > 32)) return false
  return true
}

// Wave 15/CupFinal: on-device coach + VLM + OCR system pills.
//
// system:coach carries the voice-coach LLM output (text) plus an optional
// `kind` marker ('voice-out' | 'voice-in') and an optional `tool_calls`
// mirror of the roomBot shape. All fields are peer-authored — the room does
// NOT gate authorship since these represent the LOCAL peer's own model output
// (no host trust required). Text cap: 800 chars (matches voiceCoach MAX_REPLY_CHARS).
function isValidSystemCoach (v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:coach') return false
  if (typeof v.by_peer !== 'string') return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > 800) return false
  if (v.kind !== undefined && (typeof v.kind !== 'string' || v.kind.length > 32)) return false
  if (v.stop_reason !== undefined && (typeof v.stop_reason !== 'string' || v.stop_reason.length > 32)) return false
  if (v.tool_calls !== undefined) {
    if (!Array.isArray(v.tool_calls) || v.tool_calls.length > 8) return false
    for (const t of v.tool_calls) {
      if (!t || typeof t !== 'object') return false
      if (typeof t.name !== 'string' || t.name.length === 0 || t.name.length > 64) return false
      if (typeof t.ok !== 'boolean') return false
      if (t.error !== undefined && (typeof t.error !== 'string' || t.error.length > 96)) return false
    }
  }
  return true
}

// system:vlm-caption carries a SmolVLM2 caption (already sanitized by
// bare/vlmCaption.js sanitizeCaption). Text cap: 800 chars.
function isValidSystemVlmCaption (v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:vlm-caption') return false
  if (typeof v.by_peer !== 'string') return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > 800) return false
  return true
}

// system:ocr-read carries the OCR block summary (bare/ocr.js sanitizeText +
// FrameAnalyzePanel join). Text cap: 500 chars.
function isValidSystemOcrRead (v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:ocr-read') return false
  if (typeof v.by_peer !== 'string') return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > 500) return false
  return true
}

// Wave 3 F1: ask-the-frame answer. Peer-writer allowed (any peer authors from
// its own local model output). Text cap: 800 chars (matches askTheFrame.answer
// slice(0,280) in chat.sendSystem AND the coach 800-char cap for symmetry with
// system:coach). Optional `question` mirror capped at 160 chars.
function isValidSystemAskFrameAnswer (v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:ask-frame-answer') return false
  if (typeof v.by_peer !== 'string') return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > 800) return false
  if (v.question !== undefined && (typeof v.question !== 'string' || v.question.length > 160)) return false
  if (v.ask_id !== undefined && (typeof v.ask_id !== 'string' || v.ask_id.length > 64)) return false
  return true
}

// Wave 3 F3: goal card structured extract. Peer-writer allowed. Text cap: 800
// chars. Optional structured fields: minute (int 0-200), scorer (<=80), team
// (<=80), assist (<=80). Kept optional so a serialization miss still validates.
function isValidSystemGoalCard (v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:goal-card') return false
  if (typeof v.by_peer !== 'string') return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > 800) return false
  if (v.minute !== undefined && (typeof v.minute !== 'number' || v.minute < 0 || v.minute > 200)) return false
  if (v.scorer !== undefined && (typeof v.scorer !== 'string' || v.scorer.length > 80)) return false
  if (v.team !== undefined && (typeof v.team !== 'string' || v.team.length > 80)) return false
  if (v.assist !== undefined && (typeof v.assist !== 'string' || v.assist.length > 80)) return false
  return true
}

// Wave 13B: shape validator for `system:bot-query`. Peer-writer allowed. The
// text is capped at 500 chars (roomBot.answer() also trims to 500 before
// broadcast) so a malicious peer cannot smuggle a giant prompt through the
// autobase. `byPeer` is optional identifier (may be empty for `_anon`).
function isValidSystemBotQuery(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:bot-query') return false
  if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > 500) return false
  if (typeof v.byPeer !== 'string' || v.byPeer.length > 128) return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.query_id !== 'string' || v.query_id.length === 0 || v.query_id.length > 64) return false
  return true
}

// Wave 13B: shape validator for `system:bot-reply`. Host-only in apply()
// (mirrors the system:goal / system:commentary gate). Text cap matches
// MAX_CHARS (280) so the chat DOM row cap still holds. `tool_calls` is a
// bounded array of small structs so a compromised bot cannot flood the
// autobase with a runaway toolcall record.
function isValidSystemBotReply(v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:bot-reply') return false
  if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > MAX_CHARS) return false
  if (typeof v.byPeer !== 'string' || v.byPeer.length > 128) return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.query_id !== 'string' || v.query_id.length === 0 || v.query_id.length > 64) return false
  if (v.tool_calls !== undefined) {
    if (!Array.isArray(v.tool_calls) || v.tool_calls.length > 8) return false
    for (const t of v.tool_calls) {
      if (!t || typeof t !== 'object') return false
      if (typeof t.name !== 'string' || t.name.length === 0 || t.name.length > 64) return false
      if (typeof t.ok !== 'boolean') return false
      if (t.error !== undefined && (typeof t.error !== 'string' || t.error.length > 96)) return false
    }
  }
  return true
}

// Wave 10: pure authorship-check helper (used inside apply() and exported for
// the brittle test suite). Mirrors checkTipAckAuthorship but named separately
// so future changes to one gate class don't leak into the other.
function checkHostSystemAuthorship(writerHex, hostWriterHex) {
  if (!hostWriterHex) return true
  return writerHex === hostWriterHex
}

// Wave 7 T1: pure authorship-check helpers, exported for tests. These mirror
// the closure-scoped helpers inside createChat() but take state as arguments
// so the test suite can drive them without booting Autobase.
function checkTipAckAuthorship(writerHex, hostWriterHex) {
  if (!hostWriterHex) return true
  return writerHex === hostWriterHex
}
function checkSystemTipAuthorship(writerHex, v, hostWriterHex, confirmedTippersByTx) {
  if (!hostWriterHex) return true
  if (writerHex === hostWriterHex) return true
  if (typeof v?.tx_hash === 'string') {
    const txLower = v.tx_hash.toLowerCase()
    const existing = confirmedTippersByTx.get(txLower)
    if (!existing) return true
    return existing === writerHex
  }
  return false
}
function checkTipCongratsAuthorship(writerHex, v, hostWriterHex, confirmedTippersByTx) {
  if (!hostWriterHex) return true
  if (writerHex === hostWriterHex) return true
  if (typeof v?.tx_hash === 'string') {
    const existing = confirmedTippersByTx.get(v.tx_hash.toLowerCase())
    return existing === writerHex
  }
  return false
}

module.exports = {
  createChat,
  readSourceLang,
  normalizeLang,
  CheckoutReadOnly,
  _internal: {
    // F1 Wave 3
    APPLY_MARKER_INTERVAL,
    VERSION_MARKER_CAP,
    sanitizeText,
    isValidMessage,
    isValidSystemTipCongrats,
    chatKey,
    normalizeLang,
    readSourceLang,
    checkTipAckAuthorship,
    checkSystemTipAuthorship,
    checkTipCongratsAuthorship,
    // Wave 10 exports for brittle tests
    isValidSystemPoolOpened,
    isValidSystemMatchResult,
    isValidSystemPoolPayout,
    checkHostSystemAuthorship,
    // Wave 13A exports for brittle tests
    isValidSystemCommentary,
    // Wave 15/CupFinal exports for brittle tests
    isValidSystemCoach,
    isValidSystemVlmCaption,
    isValidSystemOcrRead,
    // Wave 3 exports for brittle tests
    isValidSystemAskFrameAnswer,
    isValidSystemGoalCard,
    // Wave 13B exports for brittle tests
    isValidSystemBotQuery,
    isValidSystemBotReply,
    // Wave 14 exports for brittle tests
    isValidSystemAttendanceIssued,
    // Tier 4 Round 2 keet-identity exports for brittle tests
    isValidIdentityProof,
    isValidSystemTip,
    // F3 goal shard exports for brittle tests
    isValidSystemGoal,
    paddedMinute,
    goalKey,
    stableGoalId,
    // D2 demo mode exports for brittle tests
    isValidSystemPredictionStake,
    isValidSystemPredictionSettle,
    // Spectator tier exports for brittle tests
    isValidSystemReaderJoined,
    MAX_GOAL_MINUTE,
    MAX_CHARS,
    GOAL_CLUSTER_COUNT,
    GOAL_CLUSTER_WINDOW_MS
  }
}
