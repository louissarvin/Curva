// Curva room orchestrator: owns per-room Autobases (playhead + chat), clips,
// backend client, and the Phase 3 tip service.
//
// The IPC layer (workers/main.js) calls openRoom() when the renderer sends
// room:join. openRoom returns the subsystems + a close() that awaits them.
// No swarm work happens here — swarm.join is handled in workers/main.js
// because the swarm outlives the room.

const Hyperbee = require('hyperbee')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createPlayhead } = require('./playhead.js')
const { createChat } = require('./chat.js')
const { createClips } = require('./clips.js')
const { createBackendClient } = require('./backend.js')
const { createTipService } = require('./tip.js')
const { createPredictionsClient } = require('./predictions.js')
const { createAttendance, attendanceFlagEnabled } = require('./attendance.js')
const {
  signInvitation,
  verifyInvitation,
  verifyInvitationWithTier
} = require('./writerInvitation.js')
const { attachTacticalChannel } = require('./tacticalChannel.js')
const { topicForSlug } = require('./topics.js')
const { createDemoTimeline, timelineFlagEnabled } = require('./demoTimeline.js')

// T3 (Final Fix Wave): peer-invitation signing seed is a per-room, per-peer
// value persisted in roomState under this key. Reading from
// `chatBase.local.keyPair.secretKey` is a bet on Autobase internal API
// stability; the Autobase README does not document `.local.keyPair` as a
// public export. We derive our own ed25519 keypair via
// hypercore-crypto.keyPair(seed) which IS a documented API. See:
//   https://github.com/holepunchto/hypercore-crypto  (keyPair(seed), randomBytes)
//   https://github.com/holepunchto/autobase          (no .local.keyPair export)
const INVITATION_SEED_KEY = 'room/invitation-seed'
const LEGACY_INVITATION_ENV = 'CURVA_LEGACY_INVITATION_KEY'

// Wave 8A: Pattern B addWriter rate limit. A malicious host cannot brick its
// own room with too many indexers, and a churn attack from a swarm of peers
// racing addWriter cannot flood the base with writer promotions.
const ADD_WRITER_LIMIT = 20
const ADD_WRITER_WINDOW_MS = 60 * 60 * 1000 // 1 hour

// Spectator tier feature flag. When false (rollout default) every invitation
// is treated as `tier: 'writer'` even if the payload explicitly requests
// reader, so a partial deploy with an old host cannot accidentally admit a
// reader-tier peer as a full writer. When true the host honors the tier field
// and diverts reader-tier invitations onto the tier-map path.
// See `memory/impl_autopass_reader.md` for the full design memo.
const SPECTATOR_TIER_ENV = 'CURVA_SPECTATOR_TIER_ENABLED'
function spectatorTierEnabled() {
  try {
    const raw = (typeof process !== 'undefined' && process.env && process.env[SPECTATOR_TIER_ENV])
    if (raw === undefined || raw === null || raw === '') return false
    return String(raw).toLowerCase() === 'true'
  } catch { return false }
}

/**
 * @param {Corestore} store
 * @param {{
 *   slug: string,
 *   isHost: boolean,
 *   myPubkey: string,
 *   backendUrl?: string,
 *   lang?: string,
 *   wallet?: object,           // optional pre-initialized wallet adapter
 *   hostSmartAddr?: string,    // host address to tip (peers only)
 *   hostOwnerAddr?: string,    // host EOA (peers only)
 *   onTipStateChange?: Function // (kind, row) => void
 * }} opts
 */
async function openRoom(store, opts) {
  if (!store) throw new TypeError('store is required')
  if (!opts || typeof opts !== 'object') throw new TypeError('opts required')
  const {
    slug,
    isHost,
    myPubkey,
    backendUrl,
    lang,
    wallet,
    hostSmartAddr,
    hostOwnerAddr,
    onTipStateChange,
    // Wave 15: optional blind-peering client passed by the Bare worker. When
    // provided AND its status().enabled is true, the room registers the chat
    // and playhead Autobase discovery keys with the third-party blind peer so
    // the room survives after every human peer disconnects. Nullable, the
    // room functions identically if this is unset (feature-flag off path).
    blindPeering,
    // Demo automation hooks: workers/main.js injects announcer + commentator +
    // log + emit here so the timeline factory can drive already-shipped code
    // paths (announcer.speak, commentator.onGoalCluster, `emit('badge:*')`).
    // All fields are optional; the timeline degrades to no-op branches when
    // any dep is missing. See bare/demoTimeline.js head memo.
    demoHooks
  } = opts
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new RangeError('slug must be a non-empty string')
  }
  if (typeof isHost !== 'boolean') throw new TypeError('isHost must be boolean')
  if (typeof myPubkey !== 'string' || myPubkey.length === 0) {
    throw new RangeError('myPubkey must be a non-empty string')
  }

  const roomStore = store.namespace('curva/room/' + slug)

  const playhead = await createPlayhead(roomStore, { isHost, myPubkey })
  const chat = await createChat(roomStore, { myPubkey })

  // T2 (Final Fix Wave): if this peer is host, publish its own writer key as
  // the trusted addWriter authority to BOTH bases so the reducers can gate
  // control blocks. `chat.setHostWriter` and `playhead.setHostWriter` accept
  // the hex form of the local writer core key.
  if (isHost) {
    try {
      const chatBase = chat.getBase?.()
      const phBase = playhead.getBase?.()
      const chatWriter = chatBase?.local?.key
      const phWriter = phBase?.local?.key
      if (chatWriter && typeof chat.setHostWriter === 'function') {
        chat.setHostWriter(b4a.toString(chatWriter, 'hex'))
      }
      if (phWriter && typeof playhead.setHostWriter === 'function') {
        playhead.setHostWriter(b4a.toString(phWriter, 'hex'))
      }
    } catch (err) {
      console.warn('[Curva][Room] host writer registration failed:', err?.message)
    }
  }

  // Shared clip index Hyperbee (see Phase 2 notes).
  const clipIndexCore = roomStore.get({ name: 'clip-index' })
  const clipIndex = new Hyperbee(clipIndexCore, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await clipIndex.ready()

  // Room state Hyperbee: holds host-tip-address record, tip log, misc room meta.
  // Host writes; peers replicate read-only. In Phase 3 the host writes and peers
  // read; a full multi-writer variant is Phase 4+.
  const roomStateCore = roomStore.get({ name: 'room-state' })
  const roomState = new Hyperbee(roomStateCore, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await roomState.ready()

  const clips = await createClips(roomStore, {
    isHost,
    myPubkey,
    sharedIndex: clipIndex
  })
  clips.publishMyDrive().catch(() => { /* best-effort */ })

  const backend = backendUrl
    ? createBackendClient(backendUrl, { lang: lang || 'en' })
    : null

  // Tip service: only wired if we have both a wallet and a hostSmartAddr.
  // Host will wire theirs pointing to their own smart address (so the host can
  // also tip other rooms / test the button); peers point to the host.
  let tip = null
  const effectiveHostAddr = hostSmartAddr ||
    (isHost && wallet ? wallet.getInfo?.().smartAddress : null)
  const effectiveHostOwner = hostOwnerAddr ||
    (isHost && wallet ? wallet.getInfo?.().ownerAddress : null)

  if (wallet && effectiveHostAddr) {
    try {
      tip = createTipService({
        wallet,
        backend,
        roomStateBee: roomState,
        tipperPubkey: myPubkey,
        hostSmartAddr: effectiveHostAddr,
        hostOwnerAddr: effectiveHostOwner,
        // Task 6: hand tip service a chat reference so on successful tip
        // submission it can append a `system:tip` message to the shared
        // chat Autobase. Reused, not a new Autobase.
        chat,
        fromHandle: opts.myHandle,
        // Wave 6 T14: host flag flows through so the tip service knows
        // whether to sign a system:tip-ack on markConfirmed.
        isHost,
        onStateChange: onTipStateChange
      })
    } catch (err) {
      // Non-fatal: room still functions without tipping.
      console.warn('[Curva][Room] tip service init failed:', err.message)
      tip = null
    }
  }

  // Wave 11: Match Prediction Pool client. Only instantiated when the flag is
  // ON — otherwise the client is null and IPC handlers respond with
  // FEATURE_DISABLED. The client uses the same backend + wallet + chat as the
  // tip service so signature material stays in one place. Host-only writes
  // (system:pool-opened, system:match-result, system:pool-payout) are already
  // gated by chat.js authorship checks; the client is the ingress path.
  const predictionsEnabled = (() => {
    try {
      const v = (typeof process !== 'undefined' && process.env && process.env.CURVA_PREDICTIONS_ENABLED) || ''
      return String(v).toLowerCase() === 'true'
    } catch { return false }
  })()
  let predictions = null
  if (predictionsEnabled && wallet && backend) {
    try {
      predictions = createPredictionsClient({
        backend,
        chat,
        wallet,
        roomSlug: slug,
        isHost,
        myPubkey,
        myHandle: opts.myHandle,
        enabled: true
      })
    } catch (err) {
      console.warn('[Curva][Room] predictions client init failed:', err.message)
      predictions = null
    }
  }

  // Wave 14: Attendance ticket tools. Host-only issuance. Peers get a null
  // service (no-op) so their IPC calls return FEATURE_DISABLED / NOT_HOST.
  let attendance = null
  if (attendanceFlagEnabled() && isHost && wallet) {
    try {
      attendance = createAttendance({
        wallet,
        chat,
        roomStateBee: roomState,
        slug,
        matchId: opts.matchId || null,
        isHost: true,
        log: (level, msg, meta) => console.log('[Curva][Attendance]', level, msg, meta || '')
      })
    } catch (err) {
      console.warn('[Curva][Room] attendance init failed:', err?.message)
      attendance = null
    }
  }

  // D1 + D2: demo-mode playhead hook fanout. Reads flags from env once at room
  // open. See memory/impl_attendance_prediction.md "Feature flag summary" for
  // the precedence rules. Notes:
  //   1. `CURVA_DEMO_MODE` is the master. When true, the child flags default
  //      true; when false the child flags default false unless explicitly set.
  //   2. Existing per-feature enable flags (`CURVA_ATTENDANCE_ENABLED`,
  //      `CURVA_PREDICTIONS_ENABLED`) still gate module instantiation above.
  //      The demo flags only decide whether the modules fire automatically.
  //   3. Docs verified against https://eips.ethereum.org/EIPS/eip-191 (N
  //      signatures, no batch primitive) and
  //      https://eips.ethereum.org/EIPS/eip-3009 (one sig per transfer).
  function readBoolEnv(name, fallback) {
    try {
      const raw = (typeof process !== 'undefined' && process.env && process.env[name])
      if (raw === undefined || raw === null || raw === '') return fallback
      return String(raw).toLowerCase() === 'true'
    } catch { return fallback }
  }
  const demoMasterOn = readBoolEnv('CURVA_DEMO_MODE', false)
  const attendanceAutoIssue = readBoolEnv('CURVA_ATTENDANCE_AUTOISSUE', demoMasterOn)
  const predictionsAutoOpen = readBoolEnv('CURVA_PREDICTIONS_AUTOOPEN', demoMasterOn)

  const demoRosterFn = typeof opts.demoRoster === 'function' ? opts.demoRoster : null
  const demoScoreFn = typeof opts.demoLiveScore === 'function' ? opts.demoLiveScore : null

  // Guards so each auto-action fires exactly once per room lifetime.
  let attendanceBatchFired = false
  let predictionsAutoOpenFired = false
  let predictionsAutoSettleFired = false
  let predictionsAutoOpenedPoolId = null

  // Turn on predictions demo mode BEFORE attaching the playhead so
  // isDemoMode() short-circuit inside attachPlayhead() sees `true`.
  if (predictionsAutoOpen && predictions && isHost) {
    try {
      predictions.enableDemoMode({ entryAmountUsdt: 1 })
    } catch (err) {
      console.warn('[Curva][Room] predictions.enableDemoMode failed:', err?.message)
    }
  }

  const demoPlayheadUnsubs = []

  async function collectDemoRoster() {
    if (demoRosterFn) {
      try {
        const r = await demoRosterFn()
        if (Array.isArray(r)) return r
      } catch (err) {
        console.warn('[Curva][Room] demoRoster callback threw:', err?.message)
      }
    }
    // Fallback: scan roomState under `attendance/` to find previously-issued
    // addresses. This lets a re-open pick up prior peers even without a
    // dedicated roster registry (which does not yet live in pear-app).
    const out = []
    try {
      const stream = roomState.createReadStream({
        gt: 'attendance/',
        lt: 'attendance0'
      })
      for await (const entry of stream) {
        const addr = entry?.value?.peerAddress
        if (typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr)) {
          out.push({ address: addr.toLowerCase(), handle: '' })
        }
      }
    } catch { /* best-effort */ }
    return out
  }

  async function collectDemoLiveScore() {
    if (demoScoreFn) {
      try {
        const s = await demoScoreFn()
        if (s && typeof s === 'object') return s
      } catch (err) {
        console.warn('[Curva][Room] demoLiveScore callback threw:', err?.message)
      }
    }
    // Fallback: no in-process goalLog module exists in pear-app today (the
    // canonical one lives at backend/src/lib/liveMatch/goalLog.ts). Return a
    // safe default so the demo settlement path still runs end to end.
    return { winner: 'HOME', homeGoals: 1, awayGoals: 0 }
  }

  async function forceSettleViaBackend(poolId) {
    if (!backend || typeof backend.baseUrl !== 'string') return { ok: false, reason: 'backend-unavailable' }
    if (typeof fetch !== 'function') return { ok: false, reason: 'no-fetch' }
    const url = backend.baseUrl + '/predictions/force-settle/' + encodeURIComponent(poolId)
    try {
      const score = await collectDemoLiveScore()
      const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' }
      const debugBearer = (typeof process !== 'undefined' && process.env && process.env.CURVA_DEBUG_BEARER) || ''
      if (debugBearer) headers.Authorization = 'Bearer ' + debugBearer
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          winner: score.winner,
          homeGoals: Number(score.homeGoals),
          awayGoals: Number(score.awayGoals)
        })
      })
      return { ok: resp.ok, status: resp.status }
    } catch (err) {
      return { ok: false, reason: err?.message || 'fetch-failed' }
    }
  }

  // Single subscription that fans out to attendance (kickoff) and predictions
  // (auto-open + auto-settle). We attach ONLY if at least one demo flag is
  // requesting host-side action, and only when isHost is true.
  if (isHost && (attendanceAutoIssue || predictionsAutoOpen)) {
    const off = playhead.onUpdate(async (state) => {
      if (!state || typeof state.match_time_ms !== 'number') return

      // D1 attendance batch mint at kickoff (match_time_ms >= 0, once).
      if (attendanceAutoIssue && attendance && !attendanceBatchFired && state.match_time_ms >= 0) {
        attendanceBatchFired = true
        try {
          const roster = await collectDemoRoster()
          const res = await attendance.issuePassesForRoster(roster)
          console.log('[Curva][Room] attendance batch:',
            res.issued.length, 'issued,',
            res.skipped.length, 'skipped,',
            res.failed.length, 'failed')
        } catch (err) {
          console.warn('[Curva][Room] attendance batch failed:', err?.message)
        }
      }

      // D2 auto-open pool at t=2s.
      if (predictionsAutoOpen && predictions && !predictionsAutoOpenFired && state.match_time_ms >= 2_000) {
        predictionsAutoOpenFired = true
        try {
          const matchId = typeof opts.matchId === 'string' ? opts.matchId : ''
          if (matchId) {
            const opened = await predictions.openPool({
              matchId,
              mode: 'winner-only',
              deadlineMs: Date.now() + 20 * 60_000
            })
            predictionsAutoOpenedPoolId = opened?.poolId || null
            console.log('[Curva][Room] predictions auto-open:', predictionsAutoOpenedPoolId)
          } else {
            console.warn('[Curva][Room] predictions auto-open skipped: no matchId')
          }
        } catch (err) {
          console.warn('[Curva][Room] predictions auto-open failed:', err?.message)
        }
      }

      // D2 auto-settle at 90 min. Reads live score, publishes result, then
      // fetches POST /predictions/force-settle/:poolId so the backend
      // settlement worker runs synchronously without waiting for the tick.
      if (predictionsAutoOpen && predictions && !predictionsAutoSettleFired && state.match_time_ms >= 5_400_000) {
        predictionsAutoSettleFired = true
        try {
          const score = await collectDemoLiveScore()
          const pid = predictionsAutoOpenedPoolId
          if (pid && score && ['HOME','AWAY','DRAW'].includes(score.winner)) {
            await predictions.publishResult({
              poolId: pid,
              winner: score.winner,
              homeGoals: Number(score.homeGoals),
              awayGoals: Number(score.awayGoals),
              matchId: typeof opts.matchId === 'string' ? opts.matchId : ''
            })
            const settleRes = await forceSettleViaBackend(pid)
            console.log('[Curva][Room] predictions auto-settle:', settleRes)
          } else {
            console.warn('[Curva][Room] predictions auto-settle skipped', {
              pid, winner: score?.winner
            })
          }
        } catch (err) {
          console.warn('[Curva][Room] predictions auto-settle failed:', err?.message)
        }
      }
    })
    demoPlayheadUnsubs.push(off)
  }

  // Wave 8A: writer roster + Pattern B addWriter plumbing.
  //
  // The host holds an in-memory rate-limit map keyed by requesting peer pubkey
  // (Hyperswarm identity, NOT autobase writer key). The persisted roster lives
  // under `room/writers/<writerHex>` in the roomState Hyperbee for bookkeeping;
  // authoritative promotion is done by Autobase itself via addWriter.
  //
  // See:
  //   https://github.com/holepunchto/autobase (addWriter, indexer:true, writable event)
  const writerAddLog = new Map() // peerPubkey -> [timestamp,...]

  function writerAddAllowed(peerPubkey) {
    const now = Date.now()
    const cutoff = now - ADD_WRITER_WINDOW_MS
    let arr = writerAddLog.get(peerPubkey)
    if (!arr) { arr = []; writerAddLog.set(peerPubkey, arr) }
    while (arr.length > 0 && arr[0] < cutoff) arr.shift()
    if (arr.length >= ADD_WRITER_LIMIT) return false
    arr.push(now)
    return true
  }

  async function loadWriterRoster() {
    const out = new Set()
    try {
      const stream = roomState.createReadStream({
        gt: 'room/writers/',
        lt: 'room/writers0'
      })
      for await (const entry of stream) {
        const hex = entry.key.slice('room/writers/'.length)
        if (/^[0-9a-f]{64}$/.test(hex)) out.add(hex)
      }
    } catch { /* best-effort */ }
    return out
  }

  const writerRoster = await loadWriterRoster()

  // Rehydrate the reader-tier denylist from persisted state so a rebooting host
  // resumes rejecting reader-tier appends without waiting for the peer to
  // re-invite. Best-effort: a stream failure leaves the Set empty and the next
  // successful handleWriterRequest re-adds the key.
  if (typeof chat.addReaderKey === 'function') {
    try {
      const stream = roomState.createReadStream({
        gt: 'room/tier-map/',
        lt: 'room/tier-map0'
      })
      for await (const entry of stream) {
        if (entry?.value?.tier === 'reader') {
          const hex = entry.key.slice('room/tier-map/'.length)
          if (/^[0-9a-f]{64}$/.test(hex)) chat.addReaderKey(hex)
        }
      }
    } catch { /* best-effort */ }
  }

  /**
   * Host-only. Validates a pair of signed invitations (one per base, since
   * chat and playhead Autobases have distinct namespaced writer keys) and
   * promotes the peer to indexer on both.
   *
   * Payload shape:
   *   {
   *     chat:     { pubkey, sig, timestamp },
   *     playhead: { pubkey, sig, timestamp }
   *   }
   *
   * The ed25519 sig on each invitation proves ownership of that particular
   * writer key — we DO NOT trust the raw peerPubkey (Hyperswarm identity)
   * for authorship. peerPubkey is used only for the per-host rate limit.
   *
   * Returns `{ ok, reason?, addedAt?, bases? }`.
   */
  async function handleWriterRequest(payload, peerPubkey) {
    if (!isHost) return { ok: false, reason: 'not-host' }
    if (!payload || typeof payload !== 'object') {
      return { ok: false, reason: 'invalid-payload' }
    }
    const chatInv = payload.chat
    const phInv = payload.playhead

    // Verify with tier so a reader-tier invitation cannot be silently downgraded
    // by a re-serialization step in the wire path. Callers that only need the
    // boolean gate use the plain `verifyInvitation` above; here we branch on
    // the returned tier and MUST know it.
    const chatRes = verifyInvitationWithTier(chatInv)
    const phRes = verifyInvitationWithTier(phInv)
    if (!chatRes.ok) return { ok: false, reason: 'bad-chat-signature-or-expired' }
    if (!phRes.ok) return { ok: false, reason: 'bad-playhead-signature-or-expired' }

    // Feature-flag gate: when the spectator tier is OFF, any reader-tier
    // invitation is treated as writer so an experimental client running against
    // an unupgraded host does not brick itself. When ON, both invitations MUST
    // agree on tier so a malformed payload cannot mint a hybrid promotion.
    const flagOn = spectatorTierEnabled()
    let tier
    if (!flagOn) {
      tier = 'writer'
    } else {
      if (chatRes.tier !== phRes.tier) {
        return { ok: false, reason: 'tier-mismatch' }
      }
      tier = chatRes.tier
    }

    if (typeof peerPubkey !== 'string' || peerPubkey.length === 0) {
      return { ok: false, reason: 'peer-id-required' }
    }
    if (!writerAddAllowed(peerPubkey)) {
      return { ok: false, reason: 'rate-limited' }
    }

    const chatWriterHex = chatInv.pubkey.toLowerCase()
    const phWriterHex = phInv.pubkey.toLowerCase()

    // Idempotent: if we've already added this pair, ack success so peer
    // doesn't panic-fall-back to Pattern A on reconnect. Reader-tier peers are
    // never in `writerRoster`, so this short-circuit is writer-tier only.
    if (writerRoster.has(chatWriterHex) && writerRoster.has(phWriterHex)) {
      return { ok: true, reason: 'already-writer', tier: 'writer', addedAt: Date.now(), bases: ['chat', 'playhead'] }
    }

    const addedAt = Date.now()

    if (tier === 'reader') {
      // Reader-tier (Autopass idiom). We do NOT call `base.append({addWriter})`
      // at all. The peer's key never reaches Autobase's writer roster, so any
      // optimistic `base.append()` from that peer is rejected at the linearizer
      // level by autobase itself (source: pear-app/node_modules/autobase/lib/apply-state.js
      // gates admission on system.get(writer.core.key)). Defense-in-depth
      // is added via chat.js `addReaderKey`, which drops any message from a
      // reader hex before it can reach `view.put`.
      //
      // Persist under `room/tier-map/<hex>` so a rebooting host loads the
      // reader denylist back into chat.js.
      try {
        await roomState.put('room/tier-map/' + chatWriterHex, {
          base: 'chat', addedAt, invitedBy: myPubkey, tier: 'reader'
        })
        await roomState.put('room/tier-map/' + phWriterHex, {
          base: 'playhead', addedAt, invitedBy: myPubkey, tier: 'reader'
        })
      } catch { /* best-effort persistence */ }

      if (typeof chat.addReaderKey === 'function') {
        chat.addReaderKey(chatWriterHex)
        chat.addReaderKey(phWriterHex)
      }

      // Broadcast roster metadata so peers see the reader join. Host-only
      // gated in chat.js apply() (same model as system:commentary and other
      // system:* broadcasts). Emitted best-effort: a stale send-side failure
      // does not undo the tier-map write above.
      try {
        if (typeof chat.sendSystem === 'function') {
          await chat.sendSystem({
            type: 'system:reader-joined',
            by_peer: myPubkey,
            wall_clock_ms: addedAt,
            match_time_ms: 0,
            readerHex: chatWriterHex
          })
        }
      } catch (err) {
        console.log('[Curva][Room] system:reader-joined broadcast failed:', err?.message)
      }

      return { ok: true, tier: 'reader', addedAt, bases: ['chat', 'playhead'] }
    }

    // Writer-tier path (unchanged). Autobase Pattern B addWriter is done by
    // appending a control block that the reducer applies via `host.addWriter(...)`
    // — see the autobase README
    // (`if (value.addWriter) await host.addWriter(value.addWriter, { indexer: true })`).
    // A direct `base.addWriter(...)` method does NOT exist on the Autobase
    // instance (that method lives on the `host` object passed to apply()).
    try {
      const chatBase = chat.getBase?.()
      const phBase = playhead.getBase?.()
      if (!chatBase || !phBase) return { ok: false, reason: 'base-not-ready' }
      await chatBase.append({ addWriter: chatWriterHex, indexer: true })
      await phBase.append({ addWriter: phWriterHex, indexer: true })
    } catch (err) {
      return { ok: false, reason: 'addWriter-failed:' + (err?.message || 'unknown') }
    }

    writerRoster.add(chatWriterHex)
    writerRoster.add(phWriterHex)
    try {
      await roomState.put('room/writers/' + chatWriterHex, {
        base: 'chat', addedAt, invitedBy: myPubkey
      })
      await roomState.put('room/writers/' + phWriterHex, {
        base: 'playhead', addedAt, invitedBy: myPubkey
      })
    } catch { /* bookkeeping only; autobase already promoted */ }

    // Keep chat's anti-spoofing tip-authorship in sync with the roster so a
    // promoted writer that is also a tipper does not get their system:tip
    // dropped. Non-authoritative writers are still rejected for system:tip-ack
    // and forged system:tip-congrats (see chat.js line 122).
    if (typeof chat.addAuthorizedWriter === 'function') {
      chat.addAuthorizedWriter(chatWriterHex)
    }
    // Upgrade path: a peer previously admitted as reader is now being promoted
    // to writer. Remove their key from the chat reader denylist so their
    // appends stop being silently dropped at apply(). No-op for peers that
    // were never readers.
    if (typeof chat.removeReaderKey === 'function') {
      chat.removeReaderKey(chatWriterHex)
      chat.removeReaderKey(phWriterHex)
    }
    // Clean up any stale tier-map entry for the same hex so the persisted
    // state reflects the current writer tier on rehydration.
    try {
      await roomState.del('room/tier-map/' + chatWriterHex)
      await roomState.del('room/tier-map/' + phWriterHex)
    } catch { /* best-effort */ }

    return { ok: true, tier: 'writer', addedAt, bases: ['chat', 'playhead'] }
  }

  // T3 (Final Fix Wave): load or generate a persisted per-peer invitation
  // signing seed. Storing the seed in the roomState Hyperbee (which is per-
  // peer since it lives under our corestore namespace) keeps the invitation
  // identity stable across restarts without touching Autobase internals.
  //
  // Legacy path: `CURVA_LEGACY_INVITATION_KEY=1` falls back to the old
  // `chatBase.local.keyPair` approach for exactly one release so peers
  // that already have a room open under the old scheme can still be verified
  // by an upgraded host. Default is the new persisted-seed path.
  async function loadOrCreateInvitationSeeds() {
    const chatEntry = await roomState.get(INVITATION_SEED_KEY + '/chat').catch(() => null)
    const phEntry = await roomState.get(INVITATION_SEED_KEY + '/playhead').catch(() => null)

    let chatSeed = chatEntry?.value?.seedHex
      ? b4a.from(chatEntry.value.seedHex, 'hex')
      : null
    let phSeed = phEntry?.value?.seedHex
      ? b4a.from(phEntry.value.seedHex, 'hex')
      : null

    if (!chatSeed || chatSeed.byteLength !== 32) {
      chatSeed = crypto.randomBytes(32)
      try {
        await roomState.put(INVITATION_SEED_KEY + '/chat', {
          seedHex: b4a.toString(chatSeed, 'hex'),
          createdAt: Date.now()
        })
      } catch { /* persistence is best-effort; in-mem seed still works */ }
    }
    if (!phSeed || phSeed.byteLength !== 32) {
      phSeed = crypto.randomBytes(32)
      try {
        await roomState.put(INVITATION_SEED_KEY + '/playhead', {
          seedHex: b4a.toString(phSeed, 'hex'),
          createdAt: Date.now()
        })
      } catch { /* persistence is best-effort */ }
    }
    return {
      chat: crypto.keyPair(chatSeed),
      playhead: crypto.keyPair(phSeed)
    }
  }

  // Lazy-init: only populated on first signMyWriterInvitations() call.
  let invitationKeyPairs = null
  async function getInvitationKeyPairs() {
    if (invitationKeyPairs) return invitationKeyPairs
    invitationKeyPairs = await loadOrCreateInvitationSeeds()
    return invitationKeyPairs
  }

  /**
   * Peer-only. Produces the two-invitation payload the host expects. The
   * chat + playhead invitation keypairs are derived from persisted seeds
   * (T3 Final Fix Wave) rather than Autobase's undocumented
   * `chatBase.local.keyPair`. Legacy env `CURVA_LEGACY_INVITATION_KEY=1`
   * restores the old behavior for one release.
   *
   * NOTE: the invitation pubkey is now DIFFERENT from the Autobase writer
   * core key. It is still a valid ed25519 pubkey that proves the peer holds
   * the corresponding seed. The host's addWriter still promotes the writer's
   * `base.local.key` (fetched via `getMyWriterKeys()` below) as the actual
   * Autobase writer.
   */
  async function signMyWriterInvitations(opts) {
    // Optional tier field: default to legacy (no tier) so the produced payload
    // is byte-compat with pre-spectator-tier hosts. When explicitly set the
    // resulting sig binds to the tier (v2 canonical bytes).
    const rawTier = opts && typeof opts === 'object' ? opts.tier : undefined
    if (rawTier !== undefined) {
      if (rawTier !== 'reader' && rawTier !== 'writer') {
        throw new RangeError('tier must be one of reader|writer')
      }
      if (rawTier === 'reader' && !spectatorTierEnabled()) {
        const err = new Error('FEATURE_DISABLED')
        err.code = 'FEATURE_DISABLED'
        throw err
      }
    }
    const signOpts = rawTier !== undefined ? { tier: rawTier } : undefined

    if (process.env[LEGACY_INVITATION_ENV] === '1') {
      const chatBase = chat.getBase?.()
      const phBase = playhead.getBase?.()
      if (!chatBase?.local?.keyPair || !phBase?.local?.keyPair) {
        throw new Error('local writer keypairs not ready')
      }
      return {
        chat: signInvitation(chatBase.local.keyPair, undefined, signOpts),
        playhead: signInvitation(phBase.local.keyPair, undefined, signOpts),
        ...(rawTier !== undefined ? { tier: rawTier } : {})
      }
    }

    const { chat: chatKp, playhead: phKp } = await getInvitationKeyPairs()
    return {
      chat: signInvitation(chatKp, undefined, signOpts),
      playhead: signInvitation(phKp, undefined, signOpts),
      ...(rawTier !== undefined ? { tier: rawTier } : {})
    }
  }

  function getWriterRoster() {
    return new Set(writerRoster)
  }

  // TODO(wave-8d): unified catchup — return { playhead, chat (last 200),
  // clips index only, writers full roster, reactions } as a single snapshot
  // for late joiners, wired to a `room:catchup` IPC with progress events.

  // If host, publish tip address into room state.
  if (isHost && wallet) {
    const info = wallet.getInfo?.()
    if (info?.smartAddress && info?.ownerAddress) {
      await roomState.put('room/host-tip-address', {
        chainId: info.chainId,
        smartAddress: info.smartAddress,
        ownerAddress: info.ownerAddress,
        smartAddressDeployed: false,
        publishedAt: Date.now()
      })
    }
  }

  // Tactical drawing channel (protomux, ephemeral).
  //
  // The host publishes its Hyperswarm identity pubkey into room-state so peers
  // can validate `freeze`/`unfreeze` frames. Peers read the same key lazily
  // via `hostPubkeyRef.get()` — read-through on every inbound host frame so a
  // late-arriving host-pubkey write still unblocks verification without a
  // channel restart.
  if (isHost) {
    try {
      await roomState.put('room/host-pubkey', {
        pubkeyHex: myPubkey,
        publishedAt: Date.now()
      })
    } catch (err) {
      console.warn('[Curva][Room] host-pubkey publish failed:', err?.message)
    }
  }

  // Cached host pubkey hex. Host: known immediately (myPubkey). Peer: filled
  // lazily on first read from roomState.
  let cachedHostPubkeyHex = isHost ? String(myPubkey || '').toLowerCase() : ''
  let hostPubkeyRefreshInFlight = null
  async function refreshHostPubkey() {
    if (isHost) return cachedHostPubkeyHex
    if (hostPubkeyRefreshInFlight) return hostPubkeyRefreshInFlight
    hostPubkeyRefreshInFlight = (async () => {
      try {
        const entry = await roomState.get('room/host-pubkey')
        const hex = entry?.value?.pubkeyHex
        if (typeof hex === 'string' && hex.length > 0) {
          cachedHostPubkeyHex = hex.toLowerCase()
        }
      } catch { /* best-effort */ }
      hostPubkeyRefreshInFlight = null
      return cachedHostPubkeyHex
    })()
    return hostPubkeyRefreshInFlight
  }
  // Kick off an initial refresh so the peer path warms the cache without
  // blocking openRoom on replication catchup.
  if (!isHost) refreshHostPubkey().catch(() => {})

  const hostPubkeyRef = {
    get() {
      // If empty on peer, schedule a lazy refresh so the next inbound frame
      // will succeed. Do NOT await here — this method is called from the
      // channel's sync onmessage path.
      if (!cachedHostPubkeyHex && !isHost) refreshHostPubkey().catch(() => {})
      return cachedHostPubkeyHex || null
    }
  }

  // Room-scoped tactical event bus. workers/main.js (or any consumer) can
  // subscribe with `room.onTactical(kind, cb)` and receive validated frames.
  // Kinds: 'stroke' | 'presence' | 'typing' | 'freeze' | 'unfreeze'.
  const tacticalSubs = {
    stroke: new Set(),
    presence: new Set(),
    typing: new Set(),
    freeze: new Set(),
    unfreeze: new Set()
  }
  function fanTactical(kind, msg) {
    const set = tacticalSubs[kind]
    if (!set) return
    for (const cb of set) {
      try { cb(msg) } catch (err) {
        console.warn('[Curva][Room] tactical fanout error', kind, err?.message)
      }
    }
  }
  function onTactical(kind, cb) {
    if (!tacticalSubs[kind]) throw new RangeError('unknown tactical kind: ' + kind)
    if (typeof cb !== 'function') throw new TypeError('cb must be function')
    tacticalSubs[kind].add(cb)
    return () => tacticalSubs[kind].delete(cb)
  }

  // Per-connection tactical channel handles. Keyed by the connection object
  // so `detachTacticalForConn(conn)` can be called from the swarm's
  // 'close' callback. Values are the handle returned by attachTacticalChannel.
  const tacticalHandles = new Map()
  const roomTopic = topicForSlug(slug)

  /**
   * Attach a tactical channel to a corestore replication stream (or an
   * already-resolved Protomux). Idempotent per `conn` — a second call with
   * the same connection returns the existing handle.
   *
   * @param {object} streamOrMux  return value of `store.replicate(conn)` OR
   *                              a Protomux resolved via
   *                              `Hypercore.getProtocolMuxer(stream)`.
   * @param {object} [conn]       optional swarm connection used as the map
   *                              key; if omitted, the stream itself is used.
   * @returns {object|null}       tactical handle, or null on failure
   */
  function attachTacticalToStream(streamOrMux, conn) {
    const key = conn || streamOrMux
    if (tacticalHandles.has(key)) return tacticalHandles.get(key)
    try {
      const handle = attachTacticalChannel(streamOrMux, {
        roomTopic,
        isHost,
        hostPubkeyRef,
        myPubkeyHex: myPubkey,
        onStroke:   (m) => fanTactical('stroke', m),
        onPresence: (m) => fanTactical('presence', m),
        onTyping:   (m) => fanTactical('typing', m),
        onFreeze:   (m) => fanTactical('freeze', m),
        onUnfreeze: (m) => fanTactical('unfreeze', m)
      })
      tacticalHandles.set(key, handle)
      return handle
    } catch (err) {
      console.warn('[Curva][Room] tactical attach failed:', err?.message)
      return null
    }
  }

  function detachTacticalForConn(conn) {
    const key = conn
    const h = tacticalHandles.get(key)
    if (!h) return false
    try { h.close() } catch { /* noop */ }
    tacticalHandles.delete(key)
    return true
  }

  // Fan-out senders. Broadcast to every attached channel; the caller does not
  // need to know which peers are live.
  function forEachTactical(fn) {
    for (const h of tacticalHandles.values()) {
      try { fn(h) } catch (err) {
        console.warn('[Curva][Room] tactical send error:', err?.message)
      }
    }
  }
  function sendTacticalStroke(payload)   { forEachTactical((h) => h.sendStroke(payload)) }
  function sendTacticalPresence(payload) { forEachTactical((h) => h.sendPresence(payload)) }
  function sendTacticalTyping(payload)   { forEachTactical((h) => h.sendTyping(payload)) }
  function sendTacticalFreeze(payload) {
    if (!isHost) return false
    forEachTactical((h) => h.sendFreeze(payload))
    return true
  }
  function sendTacticalUnfreeze(payload) {
    if (!isHost) return false
    forEachTactical((h) => h.sendUnfreeze(payload))
    return true
  }

  // Wave 15: blind-peering registration hook. When the CURVA_BLIND_PEERING_ENABLED
  // flag is on AND CURVA_BLIND_PEER_KEY is set, `blindPeering` is a live client
  // (see bare/blindPeering.js). We register the chat + playhead Autobase
  // discovery keys so the third-party blind peer can seed the room when no
  // human peer is online. The blind peer NEVER receives the room's read key;
  // replication is discovery-key-only. Registration is best-effort — a failed
  // register does not abort room open. Runs for BOTH host and peer roles
  // because any peer's local Autobase view being seeded increases room
  // resilience.
  const blindPeeringRegs = []
  if (blindPeering && typeof blindPeering.status === 'function') {
    try {
      const st = blindPeering.status()
      if (st && st.enabled && st.active) {
        const chatBase = chat.getBase?.()
        const phBase = playhead.getBase?.()
        for (const [label, base] of [['chat', chatBase], ['playhead', phBase]]) {
          if (!base) continue
          try {
            const res = await blindPeering.registerAutobase(base)
            if (res?.ok) {
              blindPeeringRegs.push({ label, base })
            } else {
              console.warn('[Curva][Room] blind-peering registerAutobase declined',
                { base: label, reason: res?.reason })
            }
          } catch (err) {
            console.warn('[Curva][Room] blind-peering registerAutobase threw',
              { base: label, message: err?.message })
          }
        }
      }
    } catch (err) {
      console.warn('[Curva][Room] blind-peering status check failed', { message: err?.message })
    }
  }

  let closed = false
  async function close() {
    if (closed) return
    closed = true
    const errs = []
    // Detach the demo playhead subscription first so no more auto-fire
    // callbacks can queue behind the close.
    for (const off of demoPlayheadUnsubs) {
      try { off() } catch (err) { errs.push(err) }
    }
    // Tear down every tactical channel handle. The channels are ephemeral
    // side-traffic; there is no drain step.
    for (const h of tacticalHandles.values()) {
      try { h.close() } catch (err) { errs.push(err) }
    }
    tacticalHandles.clear()
    for (const set of Object.values(tacticalSubs)) set.clear()
    // Wave 15: unregister blind-peering entries FIRST so the client stops
    // making addAutobase attempts against a base that is about to close. This
    // keeps close() idempotent even if the blind peer is unreachable.
    if (blindPeering && blindPeeringRegs.length > 0) {
      for (const { base } of blindPeeringRegs) {
        try { await blindPeering.unregisterAutobase(base) }
        catch (err) { errs.push(err) }
      }
    }
    try { if (tip) tip.close() } catch (err) { errs.push(err) }
    try { await playhead.close() } catch (err) { errs.push(err) }
    try { await chat.close() } catch (err) { errs.push(err) }
    try { await clips.close() } catch (err) { errs.push(err) }
    try { await clipIndex.close() } catch (err) { errs.push(err) }
    try { await roomState.close() } catch (err) { errs.push(err) }
    if (errs.length > 0) {
      const first = errs[0]
      throw new Error('close errors: ' + first.message)
    }
  }

  // Demo automation timeline. Host-only. Feature-flagged by
  // CURVA_DEMO_AUTOMATION_ENABLED. See bare/demoTimeline.js. The instance is
  // lazy-created on the first trigger so opening a room does no work when the
  // flag is off. Callers on non-host or with the flag off receive null status.
  let demoTimeline = null
  function ensureDemoTimeline() {
    if (demoTimeline) return demoTimeline
    if (!isHost) return null
    if (!timelineFlagEnabled()) return null
    const hooks = demoHooks || {}
    demoTimeline = createDemoTimeline({
      room: { slug, isHost, myPubkey },
      chat,
      tip,
      predictions,
      attendance,
      playhead,
      announcer: hooks.announcer || null,
      commentator: hooks.commentator || null,
      log: typeof hooks.log === 'function'
        ? hooks.log
        : (level, msg, extra) => console.log('[Curva][DemoTimeline]', level, msg, extra || ''),
      emit: typeof hooks.emit === 'function' ? hooks.emit : () => {},
      now: typeof hooks.now === 'function' ? hooks.now : () => Date.now()
    })
    return demoTimeline
  }
  function triggerDemoTimeline() {
    const tl = ensureDemoTimeline()
    if (!tl) return null
    return tl.start()
  }
  function abortDemoTimeline() {
    if (!demoTimeline) return { state: 'idle', elapsedMs: 0, currentStep: 0, totalSteps: 0 }
    return demoTimeline.stop()
  }
  function demoTimelineStatus() {
    if (!demoTimeline) return { state: 'idle', elapsedMs: 0, currentStep: 0, totalSteps: 0 }
    return demoTimeline.status()
  }

  return {
    slug,
    isHost,
    myPubkey,
    playhead,
    chat,
    clips,
    clipIndex,
    roomState,
    backend,
    tip,
    // Wave 11: Match Prediction Pool client. Nullable — see predictionsEnabled
    // gate above. workers/main.js checks for null and short-circuits IPC
    // handlers with { error: 'FEATURE_DISABLED' } when it is.
    predictions,
    // Wave 14: attendance ticket tools. Host-only. Nullable — workers/main.js
    // checks and short-circuits IPC handlers with FEATURE_DISABLED.
    attendance,
    // Wave 8A Pattern B addWriter surface. `handleWriterRequest` is host-side;
    // `signMyWriterInvitations` is peer-side. `getWriterRoster` exposes the
    // persisted roster for UI + anti-spoofing wiring.
    handleWriterRequest,
    signMyWriterInvitations,
    getWriterRoster,
    // Tactical drawing channel surface. Callers wire per-connection channels
    // by invoking `attachTacticalToStream(stream, conn)` in the swarm's
    // 'connection' handler and `detachTacticalForConn(conn)` on close.
    // Renderer-facing sends fan out to all attached channels.
    attachTacticalToStream,
    detachTacticalForConn,
    onTactical,
    sendTacticalStroke,
    sendTacticalPresence,
    sendTacticalTyping,
    sendTacticalFreeze,
    sendTacticalUnfreeze,
    // Exposed for tests + workers/main.js retro-attach on late room:join.
    getHostPubkeyRef: () => hostPubkeyRef,
    getRoomTopic: () => roomTopic,
    // Demo automation surface. Host-only + flag-gated at construction; on non-
    // host or flag-off calls, trigger returns null. See bare/demoTimeline.js.
    triggerDemoTimeline,
    abortDemoTimeline,
    demoTimelineStatus,
    close
  }
}

module.exports = { openRoom }
