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
const { signInvitation, verifyInvitation } = require('./writerInvitation.js')

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
    // the room survives after every human peer disconnects. Nullable — the
    // room functions identically if this is unset (feature-flag off path).
    blindPeering
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
    if (!verifyInvitation(chatInv)) return { ok: false, reason: 'bad-chat-signature-or-expired' }
    if (!verifyInvitation(phInv)) return { ok: false, reason: 'bad-playhead-signature-or-expired' }
    if (typeof peerPubkey !== 'string' || peerPubkey.length === 0) {
      return { ok: false, reason: 'peer-id-required' }
    }
    if (!writerAddAllowed(peerPubkey)) {
      return { ok: false, reason: 'rate-limited' }
    }

    const chatWriterHex = chatInv.pubkey.toLowerCase()
    const phWriterHex = phInv.pubkey.toLowerCase()

    // Idempotent: if we've already added this pair, ack success so peer
    // doesn't panic-fall-back to Pattern A on reconnect.
    if (writerRoster.has(chatWriterHex) && writerRoster.has(phWriterHex)) {
      return { ok: true, reason: 'already-writer', addedAt: Date.now(), bases: ['chat', 'playhead'] }
    }

    // Autobase Pattern B addWriter is done by appending a control block that
    // the reducer applies via `host.addWriter(...)` — see the autobase README
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

    const addedAt = Date.now()
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

    return { ok: true, addedAt, bases: ['chat', 'playhead'] }
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
  async function signMyWriterInvitations() {
    if (process.env[LEGACY_INVITATION_ENV] === '1') {
      const chatBase = chat.getBase?.()
      const phBase = playhead.getBase?.()
      if (!chatBase?.local?.keyPair || !phBase?.local?.keyPair) {
        throw new Error('local writer keypairs not ready')
      }
      return {
        chat: signInvitation(chatBase.local.keyPair),
        playhead: signInvitation(phBase.local.keyPair)
      }
    }

    const { chat: chatKp, playhead: phKp } = await getInvitationKeyPairs()
    return {
      chat: signInvitation(chatKp),
      playhead: signInvitation(phKp)
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
    close
  }
}

module.exports = { openRoom }
