// Curva Bare main worker.
// Owns Hyperswarm + Corestore. Phase 1 will add Autobase playhead + chat.
//
// argv layout (set by electron/main.js):
//   [2] storage dir            <- authoritative from PearRuntime
//   [3] app path (nullable)
//   [4] updates flag ('true'|'false')
//   [5] version
//   [6] upgrade key
//   [7] app filename
//   [8] room slug              <- Curva
//   [9] is-host ('true'|'false') <- Curva
//   [10] backend URL           <- Curva
//
// The 'ready'/'peer:*'/'dht:cold-start-time' events are emitted as framed JSON
// on the IPC pipe. The renderer's app.js consumes them.

// Bare-runtime compatibility: Bare has no `process` global. Downstream modules
// (bare/clips.js:68, tip.js, translate.js, wallet/worklet.js, and ~24 sites
// total) all read `process.env.<X>` for feature flags. Polyfill a minimal
// `process` object at the top so every downstream require can transparently
// use `process.env`. bare-env is a Proxy over bare-os.getEnv, which reads the
// OS-level environment inherited from the Electron parent process.
if (typeof globalThis.process === 'undefined') {
  globalThis.process = { env: require('bare-env') }
}

const PearRuntime = require('pear-runtime')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const goodbye = require('graceful-goodbye')
const FramedStream = require('framed-stream')
const path = require('bare-path')
const fs = require('bare-fs')
const b4a = require('b4a')

const {
  topicForSlug,
  fetchPearAppKey,
  getCachedPearAppKey,
  fetchRelayInfo,
  getCachedRelayInfo,
  createPeerCountLookup,
  createSeederStats
} = require('../bare/topics.js')
const { handleFromPubkey } = require('../bare/identity.js')
const { openRoom } = require('../bare/room.js')
const { createBackendClient } = require('../bare/backend.js')
const { createTranslator } = require('../bare/translate.js')
const { readSourceLang } = require('../bare/chat.js')
const { createWalletAdapter } = require('../bare/wallet/worklet.js')
const { SEPOLIA, DEMO_AMOUNT_BASE_UNITS } = require('../bare/wallet/eip3009.js')
const { createLatencyTracker } = require('../bare/diagnostics.js')
const { suspendSwarm, resumeSwarm } = require('../bare/swarmLifecycle.js')

const pipe = new FramedStream(Bare.IPC)

const config = {
  dir: Bare.argv[2],
  app: Bare.argv[3],
  updates: Bare.argv[4] !== 'false',
  version: Bare.argv[5],
  upgrade: Bare.argv[6],
  name: Bare.argv[7],
  roomSlug: Bare.argv[8] || 'demo-room',
  isHost: Bare.argv[9] === 'true',
  backendUrl: Bare.argv[10] || 'http://localhost:3700'
}

// -- structured logging ----------------------------------------------------

function log(level, msg, extra) {
  const line = { level, msg, ts: Date.now(), ...(extra || {}) }
  // Also mirror to stdout with a prefix for developer visibility.
  console.log(`[Curva] ${level.toUpperCase()} ${msg}`, extra ?? '')
  try {
    pipe.write(
      b4a.from(
        JSON.stringify({ event: 'log', payload: line })
      )
    )
  } catch {
    // pipe may not be writable during teardown; swallow.
  }
}

function emit(event, payload) {
  try {
    pipe.write(b4a.from(JSON.stringify({ event, payload })))
  } catch (err) {
    console.error('[Curva] emit failed:', event, err.message)
  }
}

// Wave 8A: write a JSON frame to a raw Hyperswarm socket. Used by the
// Pattern B writer-invitation handshake, which cannot travel over Autobase
// (the peer is not yet a writer). Non-throwing — a socket that closed
// mid-handshake just drops the frame.
function writeSocketJson(conn, obj) {
  if (!conn || typeof conn.write !== 'function') return
  try {
    conn.write(b4a.from(JSON.stringify(obj)))
  } catch (err) {
    console.error('[Curva] writeSocketJson failed:', err.message)
  }
}

// -- storage ---------------------------------------------------------------

const corestoreDir = path.join(config.dir, 'curva', 'corestore')
try {
  fs.mkdirSync(corestoreDir, { recursive: true })
} catch (err) {
  if (err.code !== 'EEXIST') {
    console.error('[Curva] failed to mkdir corestore:', err.message)
    Bare.exit(1)
  }
}
log('info', 'storage ready', { corestoreDir })

const store = new Corestore(corestoreDir)

// -- Wave 8B T1: relayThrough NAT fallback --------------------------------
// We construct the swarm with a `relayThrough` function that returns the
// backend seeder pubkey when either:
//   (a) the DHT randomization heuristic indicates likely symmetric NAT
//       (default hyperswarm behavior — see node_modules/hyperswarm/index.js:686
//       for the `toRelayFunction` static-key wrapper), or
//   (b) the operator forces every connection through the relay via
//       CURVA_FORCE_RELAY=1 (demo-day safety valve).
//
// If the backend is unreachable at boot, the callback returns null and
// hyperswarm falls back to plain direct connect + hole punch. This is the
// pre-Wave-8B behavior, so there is no regression.
//
// Docs: node_modules/hyperswarm/index.js:28 (option), :62 (assignment),
// :108-109 (invocation), :683-687 (function-vs-key normalization).
const forceRelayEnv = (typeof process !== 'undefined' && process.env?.CURVA_FORCE_RELAY === '1')
let relayKeyBuf = null    // Buffer|null - pubkey of the backend seeder
let relayInfoCache = null // Object|null - { pubkey, swarmKey, regions }
const relayActiveConns = new Set() // hex peerKey -> known relayed

function relayThroughFn(force, _swarmInstance) {
  if (!relayKeyBuf) return null
  if (forceRelayEnv) return relayKeyBuf
  if (force) return relayKeyBuf
  if (_swarmInstance?.dht?.randomized) return relayKeyBuf
  return null
}

const swarm = new Hyperswarm({ relayThrough: relayThroughFn })

// Final Fix Wave T-D5: eagerly open the UDX socket before the first
// `swarm.join(...)` so the swarm has a stable listen port on both IPv4/IPv6
// before topic announces. Hyperswarm calls `listen()` implicitly on first
// join, but doing it explicitly gives us a single, deterministic point to
// catch bind failures at boot rather than during a room join. This is
// documented as safe/optional in the Hyperswarm README (search for
// `swarm.listen()`), so we degrade gracefully if it throws — the implicit
// join-time listen will still run.
;(async () => {
  try {
    if (typeof swarm.listen === 'function') {
      await swarm.listen()
      log('info', 'swarm listening')
    }
  } catch (err) {
    log('warn', 'swarm.listen failed, continuing (join-time listen will retry)', {
      message: err?.message
    })
  }
})()

// Wave 8B T2: seeder stats accumulator + config.
const seederStats = createSeederStats({})
seederStats.setEnabled(false, null)

// Wave 8B T3: bounded DHT peer-count lookup pool. Reused across
// backend:live-peer-counts requests from the renderer.
const peerCountLookup = createPeerCountLookup({ swarm, ttlMs: 60_000, maxConcurrent: 10 })

// Fix Wave A T5: swarm 'connection' handler is registered ONCE, at module
// init, so subsequent joinRoom() calls do NOT stack listeners. Before this
// fix, every room join added a fresh handler, causing unbounded fan-out and
// duplicate peer:connected emits on rejoin.
// The single per-connection side effect is `store.replicate(conn)` (required
// by every join). Everything else here is observability + IPC.
swarm.on('connection', (conn, info) => {
  try { store.replicate(conn) } catch (err) {
    console.error('[Curva] store.replicate failed:', err?.message)
  }
  const peerKey = info?.publicKey ? b4a.toString(info.publicKey, 'hex') : 'unknown'

  // Wave 8B T1: detect relay usage. `info.forceRelaying` is set on PeerInfo
  // when the swarm chose to relay this connection (verified at
  // node_modules/hyperswarm/lib/peer-info.js:28). Emit `relay:connection` so
  // the renderer can flip the "via relay" chip. Under CURVA_FORCE_RELAY we
  // treat every conn as relayed since the relayThrough closure returns the
  // relay key unconditionally.
  const relayed = !!info?.forceRelaying || (forceRelayEnv && !!relayKeyBuf)
  if (relayed && peerKey !== 'unknown') {
    relayActiveConns.add(peerKey)
    emit('relay:connection', {
      relayed: true,
      remoteKey: peerKey,
      relayKey: relayInfoCache?.pubkey || null,
      at: Date.now()
    })
  }

  // Wave 8B T2: feed the seeder-stats accumulator. Every swarm connection
  // counts as a peer we're helping.
  try { seederStats.onPeerConnected(peerKey) } catch { /* noop */ }

  // Wave 8B T2 (bytes): approximate replicated bytes by observing the raw
  // stream. `conn` is a duplex noise stream — 'data' events give us inbound
  // frames. We do NOT hook writes to avoid double-counting store.replicate.
  conn.on('data', (chunk) => {
    try { seederStats.addBytes(chunk?.length || chunk?.byteLength || 0) } catch { /* noop */ }
  })

  log('info', 'swarm connection', { peer: peerKey, relayed })
  emit('peer:connected', {
    pubkey: peerKey,
    handle: peerKey !== 'unknown' ? handleFromPubkey(peerKey) : null,
    count: swarm.connections.size,
    relayed
  })
  conn.on('close', () => {
    log('info', 'swarm connection closed', { peer: peerKey })
    if (relayed) relayActiveConns.delete(peerKey)
    try { seederStats.onPeerDisconnected(peerKey) } catch { /* noop */ }
    emit('peer:disconnected', { pubkey: peerKey, count: swarm.connections.size })
  })
  conn.on('error', (err) => {
    log('warn', 'swarm connection error', { peer: peerKey, message: err.message })
  })
})

// -- Pear runtime (OTA updates) --------------------------------------------
// PearRuntime requires a valid `upgrade` pear:// key. During Phase 0 the
// package.json placeholder `pear://<CURVA_APP_KEY>` is not a real key, so we
// only instantiate PearRuntime when the key looks valid. Once Phase 5 cuts
// a real release, this becomes always-on.

let pear = null
const hasValidUpgradeKey =
  typeof config.upgrade === 'string' &&
  config.upgrade.startsWith('pear://') &&
  !config.upgrade.includes('<') &&
  !config.upgrade.includes('>')

if (hasValidUpgradeKey && config.updates !== false) {
  try {
    pear = new PearRuntime({
      dir: config.dir,
      app: config.app,
      updates: config.updates,
      version: config.version,
      upgrade: config.upgrade,
      name: config.name,
      swarm,
      store
    })
    pear.updater.on('error', (err) => {
      log('warn', 'pear updater error', { message: err.message })
    })

    // Wave 8B T2: in-process pear seeder daemon.
    // When PEAR_APP_KEY is set in env we join the pear updater drive discovery
    // key in SERVER mode (i.e. announce ourselves as a seeder so other peers
    // can pull the drive from us). When PEAR_APP_KEY is absent we fall back
    // to the pre-existing client-only join so the app still receives OTA
    // updates without contributing bandwidth.
    // Note on maxPeers: hyperswarm's maxPeers is a global cap set at
    // construction. We do not currently bump it per-topic; the seeder
    // namespace shares the same pool. If the seed becomes bandwidth-bound
    // in production we can rebuild the swarm with { maxPeers: 128 }.
    const pearAppKeyEnv = (typeof process !== 'undefined' && typeof process.env?.PEAR_APP_KEY === 'string')
      ? process.env.PEAR_APP_KEY
      : null
    const seederMode = !!pearAppKeyEnv && pearAppKeyEnv.startsWith('pear://')
    if (seederMode) {
      seederStats.setEnabled(true, pearAppKeyEnv)
      log('info', 'seeder daemon enabled', { key: pearAppKeyEnv, mode: 'server' })
    } else {
      log('info', 'seeder daemon disabled (PEAR_APP_KEY unset)')
    }
    swarm.join(pear.updater.drive.core.discoveryKey, {
      client: true,
      server: seederMode
    })

    // Fix Wave A T4: pear-runtime-updater in pear-app/node_modules emits
    // `updating` + `updated` (verified at pear-app/node_modules/pear-runtime-updater/index.js:158,173).
    // The public pear-updater docs (holepunchto/pear-updater README) describe
    // `updating` + `update`. To be safe across versions, register the ready
    // handler for BOTH 'updated' and 'update' and dedupe via a seen-set on
    // version so downstream state machines are not double-toggled.
    const seenReadyVersions = new Set()
    const onUpdating = (info) => {
      pipe.write(b4a.from('updating'))
      // T5 (legacy comment): emit a structured JSON event too so the renderer can build a toast.
      // info shape varies across pear-updater versions; we send it through with
      // defensive coercion (never assumes fields exist).
      emit('update:available', {
        version: info?.version || null,
        size: typeof info?.size === 'number' ? info.size : null
      })
    }
    const onUpdated = (info) => {
      const ver = info?.version || 'unknown'
      if (seenReadyVersions.has(ver)) return
      seenReadyVersions.add(ver)
      // Cap set to avoid unbounded growth over long-running sessions.
      if (seenReadyVersions.size > 64) {
        const first = seenReadyVersions.values().next().value
        seenReadyVersions.delete(first)
      }
      pipe.write(b4a.from('updated'))
      emit('update:ready', { version: info?.version || null })
    }
    pear.updater.on('updating', onUpdating)
    pear.updater.on('updated', onUpdated)
    // Belt-and-suspenders for the docs-declared 'update' event name.
    pear.updater.on('update', onUpdated)
    log('info', 'pear runtime + updater initialized')
  } catch (err) {
    log('warn', 'pear runtime unavailable, continuing without OTA', {
      message: err.message
    })
    pear = null
  }
} else {
  log('info', 'skipping pear runtime (updates disabled or placeholder upgrade key)')
}

// -- identity --------------------------------------------------------------
// We use the store's primary key as our peer identity for Phase 0.
// Phase 1 will derive per-namespace writer keys for Autobase.

async function getPeerIdentity() {
  await store.ready()
  const core = store.get({ name: 'curva/identity' })
  await core.ready()
  const pubkeyHex = b4a.toString(core.key, 'hex')
  return {
    pubkey: pubkeyHex,
    handle: handleFromPubkey(pubkeyHex)
  }
}

// -- room join / swarm topic ----------------------------------------------

let roomDiscovery = null
let room = null                 // { slug, isHost, myPubkey, playhead, chat, close }
let roomUnsubs = []             // cleanup fns for playhead/chat listeners
let identityCache = null        // { pubkey, handle }
let wallet = null               // wallet adapter (once initialized)
let walletReady = false
let cachedHostAddresses = null  // { smartAddress, ownerAddress } discovered from room state

// Phase 3.5: QVAC translation. Opt-in per-user. Lazy-inited on first
// translate:init IPC.
let translator = null           // translator instance from bare/translate.js
let translatorInitPromise = null
let translationEnabled = false
let userTargetLang = null       // 'it' | 'id' | 'en'

// Phase 4 diagnostics: two-window playhead sync latency ring buffer.
// Populated by the room's playhead.onUpdate callback (only records events that
// originated on a DIFFERENT peer; loopback events are filtered).
const latencyTracker = createLatencyTracker({
  self: null, // populated once we know our own pubkey
  capacity: 10
})

async function joinRoom(slug) {
  const topic = topicForSlug(slug)
  const topicHex = b4a.toString(topic, 'hex')
  log('info', 'joining swarm topic', { slug, topicHex })

  // Fix Wave A T5: swarm 'connection' handler is registered ONCE at module
  // init (see above, right after `new Hyperswarm()`). Adding it here again
  // would stack listeners on every joinRoom() call. Do NOT re-add.

  const t0 = Date.now()
  roomDiscovery = swarm.join(topic, { server: true, client: true })
  await roomDiscovery.flushed()
  // Fix Wave A T6: swarm.flush() waits for the actual peer connections to
  // materialize so cold-start metrics reflect real reachability, not just DHT
  // announce completion. Best-effort — some hyperswarm versions resolve the
  // flush promise as soon as the announce is broadcast.
  try { await swarm.flush() } catch (err) {
    log('warn', 'swarm.flush failed', { message: err?.message })
  }
  const dhtMs = Date.now() - t0

  log('info', 'dht flushed', { dhtMs })
  emit('dht:cold-start-time', { ms: dhtMs })

  return { topicHex, dhtMs }
}

// ===== PREDICTIONS (Wave 11) =====
// Feature-flag: CURVA_PREDICTIONS_ENABLED. Default off. When off, every
// predictions:* IPC handler responds with { error: 'FEATURE_DISABLED' } and no
// mounting happens. Reading env once at module init so runtime toggling is not
// supported — a restart is required. Matches how CURVA_MULTIWRITER + other
// process.env gates work elsewhere in this file.
const predictionsFlagEnabled = (() => {
  try {
    const v = (typeof process !== 'undefined' && process.env && process.env.CURVA_PREDICTIONS_ENABLED) || ''
    return String(v).toLowerCase() === 'true'
  } catch { return false }
})()
log('info', 'predictions feature flag', { enabled: predictionsFlagEnabled })
// ===== END PREDICTIONS =====

// ===== QVAC COMMENTATOR (Wave 13A) =====
// QVAC LLM Room Commentator. Second QVAC primitive after NMT translation, so
// Curva now covers "translation + LLM" on-device. Host-only feature: only the
// host process loads the LLM (Qwen3 0.6B ≈ 364 MB one-time download) and only
// the host writes `system:commentary` messages to chat. Peers just render.
//
// Feature flag: CURVA_QVAC_COMMENTATOR_ENABLED. Default 'false'. Even when the
// env flag is on, nothing auto-downloads at boot — the host must click the
// "Enable commentator" toggle in the renderer so the download cost is
// explicit. See bare/commentator.js for the docs-verification memo, model
// choice justification, and prompt template.
const { createCommentator } = require('../bare/commentator.js')
const commentatorFlagEnabled = (() => {
  try {
    const v = (typeof process !== 'undefined' && process.env && process.env.CURVA_QVAC_COMMENTATOR_ENABLED) || ''
    return String(v).toLowerCase() === 'true'
  } catch { return false }
})()
log('info', 'commentator feature flag', { enabled: commentatorFlagEnabled })

let commentator = null
let commentatorGoalUnsub = null

function ensureCommentator() {
  if (commentator) return commentator
  if (!commentatorFlagEnabled) return null
  if (!room?.chat) return null
  commentator = createCommentator({
    storageDir: config.dir,
    isHost: !!config.isHost,
    chat: room.chat,
    getMatchTimeMs: () => {
      try {
        const st = room?.playhead?.state?.() || {}
        return Math.max(0, Number(st.match_time_ms || 0))
      } catch { return 0 }
    },
    getMatchTitle: () => {
      // Best-effort: room slug is a reasonable stand-in for a match title in
      // the current app. Renderer can override via CURVA_MATCH_TITLE env.
      const env = (typeof process !== 'undefined' && process.env && process.env.CURVA_MATCH_TITLE) || ''
      return env || (config.roomSlug || 'match')
    },
    getRecentChat: () => {
      // Snapshot: pull recent chat rows via history() best-effort. History is
      // async, so we keep a small ring buffer populated from onMessage below.
      return recentChatRing.slice(-5)
    },
    emit: (event, payload) => emit(event, payload),
    log
  })
  // Wire the host's goal-cluster subscription -> commentator trigger. Only the
  // host emits commentary; peers receive it via Autobase replication.
  if (config.isHost && room?.chat?.onGoalCluster) {
    commentatorGoalUnsub = room.chat.onGoalCluster((payload) => {
      commentator.onGoalCluster(payload).catch((err) => {
        log('warn', 'commentator goal-cluster trigger failed', { message: err?.message })
      })
    })
  }
  return commentator
}

// Ring buffer of last-N chat messages for prompt context. Bare's chat.onMessage
// already fires for every reduced message so we piggy-back on the same stream.
const recentChatRing = []
function pushRecentChat(msg) {
  if (!msg || typeof msg !== 'object') return
  if (msg.type && msg.type !== 'msg') return
  recentChatRing.push({
    handle: msg.handle || null,
    by_peer: msg.by_peer || null,
    text: typeof msg.text === 'string' ? msg.text.slice(0, 200) : '',
    match_time_ms: msg.match_time_ms || 0
  })
  while (recentChatRing.length > 20) recentChatRing.shift()
}
// ===== END QVAC COMMENTATOR =====

// ===== WDK X402 (Wave 13B) =====
// x402 paid-resource client. Feature-flag: CURVA_X402_ENABLED (default off).
// The Bare worker owns the wallet + fetch; the renderer only sees a PaywallModal
// prompt event and answers with x402:confirm.
//
// Pending prompts are keyed by requestId so a burst of parallel fetchPaid()
// calls does not cross-answer. Each entry holds { resolve, reject, createdAt }
// and expires after PAYWALL_PROMPT_TTL_MS to prevent unbounded map growth if a
// renderer forgets to reply.
const x402FlagEnabled = (() => {
  try {
    const v = (typeof process !== 'undefined' && process.env && process.env.CURVA_X402_ENABLED) || ''
    return String(v).toLowerCase() === 'true'
  } catch { return false }
})()
log('info', 'x402 feature flag', { enabled: x402FlagEnabled })

const { createX402Client, X402Error } = require('../bare/x402Client.js')
const PAYWALL_PROMPT_TTL_MS = 5 * 60 * 1000
const x402PendingPrompts = new Map()

function x402PurgeStalePrompts() {
  const now = Date.now()
  for (const [k, v] of x402PendingPrompts) {
    if (now - v.createdAt > PAYWALL_PROMPT_TTL_MS) {
      x402PendingPrompts.delete(k)
      try { v.reject(new X402Error('PROMPT_TIMEOUT', 'paywall prompt expired without user answer')) } catch (_) { /* noop */ }
    }
  }
}
// ===== END WDK X402 =====

// ===== ATTENDANCE (Wave 14) =====
// Attendance Ticket Tools. Host mints a per-peer EIP-191 attendance-pass on
// room open (idempotent by peer). Peers subscribe to `system:attendance-issued`
// and can query the persisted room-state Hyperbee via attendance:* IPC.
//
// Feature flag: CURVA_ATTENDANCE_ENABLED (default off). When off, every IPC
// handler responds with FEATURE_DISABLED and the room.js factory never mounts
// the attendance service. Off-chain verifier only — no on-chain settlement
// risk when the flag is flipped.
const attendanceFlagEnabledInWorker = (() => {
  try {
    const v = (typeof process !== 'undefined' && process.env && process.env.CURVA_ATTENDANCE_ENABLED) || ''
    return String(v).toLowerCase() === 'true'
  } catch { return false }
})()
log('info', 'attendance feature flag', { enabled: attendanceFlagEnabledInWorker })
// ===== END ATTENDANCE =====

// ===== BLIND PEERING (Wave 15) =====
// Docs: https://docs.pears.com/how-to/blind-peering/add-blind-peering-to-a-chat-app/
// Package: blind-peering@2.4.0 (see pear-app/bare/blindPeering.js for the docs
// verification memo). The BlindPeering instance is constructed once at boot
// against the shared Hyperswarm + Corestore so the DHT socket and store handles
// are reused. Feature-flag gated: CURVA_BLIND_PEERING_ENABLED must be exactly
// "true" AND CURVA_BLIND_PEER_KEY must be a non-empty z-base-32 pubkey. The
// factory itself no-ops when either precondition fails, so existing tests and
// deployments without a blind peer configured remain identical.
const { createBlindPeeringClient } = require('../bare/blindPeering.js')
const blindPeering = createBlindPeeringClient({
  swarm,
  corestore: store,
  logger: {
    info: (msg, extra) => log('info', 'blind-peering: ' + msg, extra),
    warn: (msg, extra) => log('warn', 'blind-peering: ' + msg, extra),
    error: (msg, extra) => log('error', 'blind-peering: ' + msg, extra)
  }
})
{
  const st = blindPeering.status()
  log('info', 'blind-peering feature flag', {
    enabled: st.enabled,
    active: st.active,
    peerKeyShort: st.peerKeyShort,
    reason: st.reason || null
  })
}
// ===== END BLIND PEERING (Wave 15) =====

// -- Wave 8A: Pattern B addWriter feature flag ----------------------------
// `CURVA_MULTIWRITER=off` disables the entire request-writer handshake so
// Pattern A (host-only reducer via ackWriter under `optimistic: true`) stays
// the sole path. Any other value (or unset) keeps Pattern B enabled.
function multiwriterEnabled() {
  const v = (typeof process !== 'undefined' && process.env && process.env.CURVA_MULTIWRITER) || ''
  return String(v).toLowerCase() !== 'off'
}

// -- room lifecycle (Phase 1) ---------------------------------------------

async function openRoomFor(slug, isHost) {
  if (room) {
    log('warn', 'openRoomFor called while room exists; closing prior room first')
    await closeCurrentRoom()
  }
  const identity = identityCache || (await getPeerIdentity())
  identityCache = identity

  room = await openRoom(store, {
    slug,
    isHost,
    myPubkey: identity.pubkey,
    myHandle: identity.handle,
    backendUrl: config.backendUrl,
    lang: 'en',
    wallet: walletReady ? wallet : null,
    hostSmartAddr: cachedHostAddresses?.smartAddress,
    hostOwnerAddr: cachedHostAddresses?.ownerAddress,
    // Wave 15: pass the shared blind-peering client. Handles feature-flag off
    // internally by returning a no-op client (see bare/blindPeering.js).
    blindPeering,
    onTipStateChange: (kind, row) => {
      // Redact secrets; keep only display-safe fields.
      emit('tip:' + kind, sanitizeTipRow(row))
    }
  })

  // Wave 15: surface a registration event so RoomHeader can flip the chip.
  try {
    const st = blindPeering.status()
    emit('blindPeering:registration', {
      slug,
      status: st,
      at: Date.now()
    })
  } catch { /* noop */ }

  // Wire subscribers. Every callback forwards to the renderer via emit().
  // Diagnostics: capture two-window playhead sync latency. record() ignores
  // loopback (our own writes) so only true remote deltas land in the ring.
  const offPh = room.playhead.onUpdate((state) => {
    const delta = latencyTracker.record({
      ...state,
      by_peer: state?.by_peer
    })
    if (typeof delta === 'number') {
      log('info', 'playhead sync latency', { ms: delta, from: (state.by_peer || '').slice(0, 8), type: state.type })
      emit('diag:latency', { ms: delta, from: (state.by_peer || '').slice(0, 8), type: state.type })
    }
    emit('playhead:update', state)
  })
  const offMsg = room.chat.onMessage((msg) => {
    const enriched = { ...msg, handle: handleFromPubkey(msg.by_peer.length >= 6 ? msg.by_peer : identity.pubkey) }
    emit('chat:msg', enriched)
    // Phase 3.5: fire-and-forget translation. Never blocks chat delivery.
    maybeTranslateMessage(enriched).catch((err) => {
      log('warn', 'auto-translate failed', { message: err.message })
    })
    // Wave 13A: keep the last-N chat rows for the LLM prompt context. Only
    // regular `msg` rows land in the ring (system messages are filtered
    // inside pushRecentChat) so a stream of tip receipts cannot displace the
    // real conversation.
    try { pushRecentChat(enriched) } catch { /* noop */ }
  })
  const offCluster = room.chat.onGoalCluster((payload) => {
    emit('chat:goal-cluster', payload)
  })
  roomUnsubs = [offPh, offMsg, offCluster]

  // -- Wave 8A: Pattern B addWriter socket handshake ----------------------
  //
  // A single swarm 'connection' listener is registered at module init (see
  // Fix Wave A T5 note above). We attach a per-connection data listener here
  // so writer-invitation frames are handled without touching that listener.
  //
  // Message frames are framed-stream JSON over the raw Hyperswarm socket.
  // Kinds:
  //   { kind: 'request-writer', payload: { chat, playhead } }
  //     -> host verifies & promotes, replies with:
  //   { kind: 'writer-added',   bases: [...], addedAt }
  //   { kind: 'writer-add-failed', reason }
  //
  // The optimistic-append (Pattern A) path in chat/playhead is preserved
  // as a fallback: if the peer never receives `writer-added`, it keeps
  // calling base.append(msg, { optimistic: true }) exactly as before.
  const writerFlagEnabled = multiwriterEnabled()
  const onConnectionForWriterHandshake = (conn) => {
    if (!room) return
    // Peer side: send our invitation as soon as the socket is open. Host
    // ignores its own invitation attempt (handleWriterRequest short-circuits
    // via `not-host`).
    if (writerFlagEnabled && !room.isHost && typeof room.signMyWriterInvitations === 'function') {
      // T3 (Final Fix Wave): signMyWriterInvitations is now async because
      // seeds are persisted in the roomState Hyperbee. Fire-and-forget the
      // send so we don't block the connection handler.
      Promise.resolve(room.signMyWriterInvitations())
        .then((payload) => {
          writeSocketJson(conn, { kind: 'request-writer', payload })
        })
        .catch((err) => {
          log('warn', 'writer-invitation sign failed', { message: err.message })
        })
    }
    conn.on('data', async (buf) => {
      let frame
      try {
        frame = JSON.parse(buf.toString())
      } catch { return /* not a writer-handshake frame */ }
      if (!frame || typeof frame !== 'object') return

      if (frame.kind === 'request-writer' && room?.isHost && writerFlagEnabled) {
        const peerHex = conn?.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex') : 'unknown'
        try {
          const res = await room.handleWriterRequest(frame.payload, peerHex)
          if (res.ok) {
            writeSocketJson(conn, {
              kind: 'writer-added',
              bases: res.bases || ['chat', 'playhead'],
              addedAt: res.addedAt
            })
            log('info', 'writer promoted (Pattern B)', {
              peer: peerHex.slice(0, 8),
              bases: res.bases
            })
            emit('room:writer-promoted', { peer: peerHex, bases: res.bases })
          } else {
            writeSocketJson(conn, { kind: 'writer-add-failed', reason: res.reason })
            log('warn', 'writer add rejected', { peer: peerHex.slice(0, 8), reason: res.reason })
          }
        } catch (err) {
          writeSocketJson(conn, { kind: 'writer-add-failed', reason: 'internal' })
          log('warn', 'writer add threw', { message: err.message })
        }
        return
      }

      if (frame.kind === 'writer-added' && !room?.isHost) {
        // Peer received host ack. base.writable will flip via Autobase's
        // 'writable' event once the addWriter block replicates through.
        emit('room:writer-added', { bases: frame.bases, addedAt: frame.addedAt })
        log('info', 'promoted to indexer by host', { bases: frame.bases })
        return
      }
      if (frame.kind === 'writer-add-failed' && !room?.isHost) {
        emit('room:writer-add-failed', { reason: frame.reason })
        log('warn', 'writer add refused by host', { reason: frame.reason })
        return
      }
    })
  }

  // Attach to existing connections, and to any new one that arrives while
  // the room is open. Removal on room close is handled below via roomUnsubs.
  if (writerFlagEnabled) {
    for (const conn of swarm.connections) {
      try { onConnectionForWriterHandshake(conn) } catch (err) {
        log('warn', 'existing conn writer-handshake attach failed', { message: err.message })
      }
    }
    swarm.on('connection', onConnectionForWriterHandshake)
    roomUnsubs.push(() => swarm.off('connection', onConnectionForWriterHandshake))

    // Wire 'writable' events so the renderer can flip its "promoted to
    // indexer" chip. Runs on host AND peer — for host it fires on ready.
    //
    // Final Fix Wave T-D3: also wire 'unwritable' so the renderer can hide
    // the chip when a peer is demoted (e.g. host removed them, or the base
    // was closed). Autobase docs pair these events: 'writable' fires on
    // promotion, 'unwritable' fires when the instance is no longer a writer
    // (holepunchto/autobase README, base events section).
    const chatBase = room.chat.getBase?.()
    const phBase = room.playhead.getBase?.()
    if (chatBase) {
      const onChatWritable = () => emit('room:base-writable', { base: 'chat' })
      const onChatUnwritable = () => emit('room:base-unwritable', { base: 'chat' })
      chatBase.on('writable', onChatWritable)
      chatBase.on('unwritable', onChatUnwritable)
      roomUnsubs.push(() => chatBase.off?.('writable', onChatWritable))
      roomUnsubs.push(() => chatBase.off?.('unwritable', onChatUnwritable))
    }
    if (phBase) {
      const onPhWritable = () => emit('room:base-writable', { base: 'playhead' })
      const onPhUnwritable = () => emit('room:base-unwritable', { base: 'playhead' })
      phBase.on('writable', onPhWritable)
      phBase.on('unwritable', onPhUnwritable)
      roomUnsubs.push(() => phBase.off?.('writable', onPhWritable))
      roomUnsubs.push(() => phBase.off?.('unwritable', onPhUnwritable))
    }
  } else {
    log('info', 'Pattern B addWriter disabled via CURVA_MULTIWRITER=off; using host-only proxy')
  }

  // Peer path: try to read host tip address from the replicated room state
  // Hyperbee. Best-effort — replication may not have completed yet, in which
  // case the renderer's tip button stays disabled until wallet:host-discovered
  // fires.
  if (!isHost && room.roomState) {
    tryDiscoverHostAddress().catch((err) =>
      log('warn', 'host tip-address discovery failed', { message: err.message })
    )
  }

  emit('room:ready', {
    slug,
    isHost,
    myPubkey: identity.pubkey,
    handle: identity.handle,
    myDriveKey: room.clips.myDriveKey,
    walletReady,
    hostSmartAddress: room.tip?.hostSmartAddr || null
  })
  log('info', 'room ready', { slug, isHost, myDriveKey: room.clips.myDriveKey })
}

async function tryDiscoverHostAddress() {
  if (!room || !room.roomState) return
  const node = await room.roomState.get('room/host-tip-address').catch(() => null)
  if (node?.value?.smartAddress) {
    cachedHostAddresses = {
      smartAddress: node.value.smartAddress,
      ownerAddress: node.value.ownerAddress
    }
    emit('tip:host-discovered', {
      chainId: node.value.chainId,
      smartAddress: node.value.smartAddress,
      ownerAddress: node.value.ownerAddress
    })
  }
}

// Wave 14: safe projection of an attendance pass onto the IPC wire. Every
// field here is already public (broadcast in chat + verifiable off-chain), but
// keeping the sanitiser explicit prevents future accidents (e.g. inadvertently
// tacking a wallet.getInfo() blob onto the pass and leaking the smart address
// through the renderer).
function sanitizeAttendancePass(pass) {
  if (!pass || typeof pass !== 'object') return null
  return {
    slug: typeof pass.slug === 'string' ? pass.slug : null,
    matchId: typeof pass.matchId === 'string' ? pass.matchId : null,
    peerAddress: typeof pass.peerAddress === 'string' ? pass.peerAddress.toLowerCase() : null,
    hostAddress: typeof pass.hostAddress === 'string' ? pass.hostAddress.toLowerCase() : null,
    issuedAt: typeof pass.issuedAt === 'number' ? pass.issuedAt : null,
    signature: typeof pass.signature === 'string' ? pass.signature : null
  }
}

function sanitizeTipRow(row) {
  if (!row) return null
  // Whitelist explicit fields — never emit `nonce` or facilitator internals
  // to the renderer. renderer only needs the display-safe subset.
  return {
    status: row.status,
    tx_hash: row.tx_hash,
    from_peer: row.from_peer,
    from_address: row.from_address,
    to_address: row.to_address,
    amount: row.amount,
    token: row.token,
    chainId: row.chainId,
    note: row.note,
    created_at: row.created_at,
    submitted_at: row.submitted_at,
    confirmed_at: row.confirmed_at,
    error: row.error || null
  }
}

// -- wallet ----------------------------------------------------------------
// The wallet lives in this module's closure for the hackathon (ADR-004
// Option B). Full worklet-process isolation is v2 hardening. The seed
// never crosses the IPC pipe: only smart/owner addresses and signature
// tuples do. See bare/wallet/worklet.js for the deeper discipline.
async function initWallet(payload) {
  if (walletReady && wallet) {
    emit('wallet:ready', walletInfoSnapshot())
    return
  }
  const passcode = payload?.passcode || process.env.DEV_WALLET_PASSCODE
  if (!passcode) {
    // Task 1: signal the renderer to prompt the user instead of throwing.
    // The renderer mounts PasscodePrompt on this event and calls
    // curva.setWalletPasscode(passcode) which re-enters initWallet with the
    // passcode in payload.
    log('info', 'wallet init deferred; requesting passcode from renderer')
    emit('wallet:passcode-required', {
      hint: 'Enter a 6-128 char passcode. Curva stores your key encrypted on this device.'
    })
    // Do NOT throw — the renderer will respond with wallet:set-passcode.
    return
  }

  // Lazy require WDK modules only when the user actually wants a wallet — keeps
  // the boot path fast and lets non-tipping demos run without WDK installed.
  //
  // Fix (2026-07-01): apply bare-semver LHS-tolerance patch BEFORE requiring
  // WDK. @noble/hashes and @noble/curves (transitive via ethers under
  // wdk-wallet-evm-erc-4337) declare `engines.node: "^14.21.3 || >=16"`,
  // which the strict bare-semver Version.parse rejects during module
  // resolution and surfaces as WALLET_DEPS_MISSING. See
  // bare/wallet/semverPatch.js for the full root-cause writeup.
  require('../bare/wallet/semverPatch.js').applyPatch()
  let WDK, WalletFactory, SecretManager, ethers
  try {
    WDK = require('@tetherto/wdk')
    WalletFactory = require('@tetherto/wdk-wallet-evm-erc-4337')
    SecretManager = require('@tetherto/wdk-secret-manager')
    ethers = require('ethers')
    // Some packages export default vs. named — normalize.
    WDK = WDK.default || WDK
    WalletFactory = WalletFactory.default || WalletFactory
    SecretManager = SecretManager.default || SecretManager
  } catch (err) {
    const msg = 'WDK dependencies unavailable: ' + err.message
    log('error', msg)
    emit('wallet:error', { code: 'WALLET_DEPS_MISSING', message: msg })
    throw new WalletInitError('WALLET_DEPS_MISSING', msg)
  }

  const storageDir = path.join(config.dir, 'curva', 'wallet')
  try {
    fs.mkdirSync(storageDir, { recursive: true })
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }

  wallet = createWalletAdapter({
    WalletFactory,
    SecretManager,
    WDK,
    ethers,
    storageDir,
    passcode,
    chain: SEPOLIA
  })

  const info = await wallet.init({ passcode, storageDir })
  walletReady = true
  emit('wallet:ready', {
    smartAddress: info.smartAddress,
    ownerAddress: info.ownerAddress,
    chainId: info.chainId,
    balance: info.balance
  })
  log('info', 'wallet ready', {
    smartAddress: info.smartAddress,
    ownerAddress: info.ownerAddress
  })

  // If we have an open room, re-open it so the tip service gets wired with the
  // newly-initialized wallet. This is cheaper than a full swarm rejoin.
  if (room) {
    const slug = room.slug
    const wasHost = room.isHost
    await closeCurrentRoom()
    await openRoomFor(slug, wasHost)
  }
}

function walletInfoSnapshot() {
  if (!wallet || !walletReady) {
    return { ready: false, smartAddress: null, ownerAddress: null, chainId: SEPOLIA.chainId }
  }
  const info = wallet.getInfo()
  return {
    ready: true,
    smartAddress: info.smartAddress,
    ownerAddress: info.ownerAddress,
    chainId: info.chainId
  }
}

class WalletInitError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

class TipNotReadyError extends Error {
  constructor() {
    super('tip service not ready (host may not have published address yet, or wallet not initialized)')
    this.code = 'TIP_NOT_READY'
  }
}

// -- Phase 3.5: QVAC translation ------------------------------------------
// The translator is opt-in. Renderer sends translate:init with a targetLang;
// we lazily download + verify Bergamot models from F12 and load them into a
// QVAC engine. Every failure degrades gracefully: `translationEnabled` flips
// false and chat continues in original-only mode.

async function ensureTranslator(targetLang) {
  if (translator) return translator
  if (translatorInitPromise) return translatorInitPromise

  // Use the backend URL from the currently open room, or fall back to
  // constructing a fresh client. F12 doesn't need a room.
  const backendClient = room?.backend || createBackendClient(config.backendUrl, { lang: 'en' })
  const storageDir = config.dir

  translatorInitPromise = createTranslator({
    storageDir,
    backendClient,
    timeoutMs: 30_000,
    onProgress: (ev) => emit('translate:progress', ev),
    onError: (err) => emit('translate:error', err)
  })
    .then((inst) => {
      translator = inst
      const st = inst.status()
      if (st.ready) {
        translationEnabled = true
        emit('translate:ready', { loaded: st.loaded, targetLang })
      } else {
        translationEnabled = false
        emit('translate:disabled', { reason: st.disabledReason || 'no models loaded' })
      }
      return inst
    })
    .catch((err) => {
      translationEnabled = false
      emit('translate:disabled', { reason: err?.message || 'init failed' })
      log('warn', 'translator init failed', { message: err?.message })
      return null
    })
    .finally(() => {
      translatorInitPromise = null
    })

  return translatorInitPromise
}

async function maybeTranslateMessage(msg) {
  if (!translationEnabled || !translator) return
  if (!userTargetLang) return
  const src = readSourceLang(msg, 'en')
  if (src === userTargetLang) return
  if (!translator.isReady(src, userTargetLang)) return
  try {
    const translated = await translator.translate({
      text: msg.text,
      from: src,
      to: userTargetLang
    })
    emit('chat:msg:translated', {
      // Key matches renderer's Chat.js keyForMessage() so the row can be found.
      originalKey: msg.wall_clock_ms + '/' + (msg.by_peer || '').slice(0, 8),
      wall_clock_ms: msg.wall_clock_ms,
      by_peer: msg.by_peer,
      sourceLang: src,
      targetLang: userTargetLang,
      translatedText: translated
    })
  } catch (err) {
    // Silent per-message failure. Never poisons the chat stream.
    log('warn', 'translate failed', { code: err.code, message: err.message })
  }
}

// -- backend SSE plumbing --------------------------------------------------

let activityStream = null
let activityReader = null

async function connectActivityFeed() {
  if (!room?.backend) {
    emit('backend:activity:status', { connected: false, reason: 'backend not configured' })
    return
  }
  if (activityStream) return // already open
  const url = room.backend.baseUrl + '/activity/stream'
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'text/event-stream', 'Accept-Language': 'en' }
    })
    if (!resp.ok || !resp.body) {
      emit('backend:activity:status', { connected: false, reason: 'http ' + resp.status })
      return
    }
    activityStream = resp
    emit('backend:activity:status', { connected: true })
    activityReader = resp.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    ;(async () => {
      try {
        while (true) {
          const { done, value } = await activityReader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'))
            if (dataLines.length === 0) continue
            const payload = dataLines.map((l) => l.slice(5).trim()).join('\n')
            try {
              const parsed = JSON.parse(payload)
              emit('backend:activity', parsed)
              // Facilitator confirmations drive our local tip state -> confirmed.
              const kind = parsed?.type || parsed?.event
              const txHash = parsed?.txHash || parsed?.tx_hash
              if (
                room?.tip &&
                typeof txHash === 'string' &&
                (kind === 'tip.confirmed' || kind === 'facilitator.confirmed')
              ) {
                room.tip.markConfirmed(txHash, { block: parsed?.block }).catch(() => { /* noop */ })
              }
            } catch { /* ignore malformed */ }
          }
        }
      } catch (err) {
        log('warn', 'activity stream errored', { message: err.message })
      } finally {
        activityStream = null
        activityReader = null
        emit('backend:activity:status', { connected: false, reason: 'closed' })
      }
    })()
  } catch (err) {
    emit('backend:activity:status', { connected: false, reason: err.message })
  }
}

function disconnectActivityFeed() {
  if (activityReader) {
    try { activityReader.cancel() } catch { /* noop */ }
  }
  activityStream = null
  activityReader = null
}

async function closeCurrentRoom() {
  if (!room) return
  const slug = room.slug
  for (const off of roomUnsubs) {
    try { off() } catch { /* noop */ }
  }
  roomUnsubs = []
  disconnectActivityFeed()
  try {
    await room.close()
  } catch (err) {
    log('warn', 'room close failed', { message: err.message })
  }
  room = null
  // Wave 15: emit unregistration event so the renderer chip can revert.
  try {
    const st = blindPeering.status()
    emit('blindPeering:registration', {
      slug,
      status: st,
      unregistered: true,
      at: Date.now()
    })
  } catch { /* noop */ }
}

// -- boot ------------------------------------------------------------------

;(async () => {
  try {
    const identity = await getPeerIdentity()
    identityCache = identity
    latencyTracker.setSelf(identity.pubkey)
    emit('ready', {
      pubkey: identity.pubkey,
      handle: identity.handle,
      isHost: config.isHost,
      roomSlug: config.roomSlug,
      backendUrl: config.backendUrl
    })
    log('info', 'ready', { pubkey: identity.pubkey, handle: identity.handle })

    // Task 8: fetch the current pear:// distribution key from the backend
    // once at cold start. Cached in bare/topics.js module scope. Non-blocking
    // and best-effort; the room join proceeds even if the backend is down.
    fetchPearAppKey(config.backendUrl).then((key) => {
      if (key) log('info', 'distribution pear-link cached', { key })
      else log('info', 'distribution pear-link unavailable; will fall back to curva:// deep link')
    }).catch(() => { /* noop */ })

    // Wave 8B T1: fetch backend seeder relay info once at cold start. Cached
    // in bare/topics.js module scope. Non-blocking; if backend is unreachable
    // relayKeyBuf stays null and hyperswarm degrades to direct-only connect.
    // We log exactly one warning so an offline backend doesn't spam the log.
    fetchRelayInfo(config.backendUrl).then((info) => {
      if (info && info.pubkey) {
        relayInfoCache = info
        try {
          relayKeyBuf = b4a.from(info.pubkey, 'hex')
        } catch (err) {
          log('warn', 'relay pubkey hex decode failed', { message: err.message })
          relayKeyBuf = null
        }
        log('info', 'relay info cached', {
          pubkey: info.pubkey.slice(0, 12) + '...',
          regions: info.regions,
          forced: forceRelayEnv
        })
        emit('relay:info', {
          pubkey: info.pubkey,
          regions: info.regions,
          forced: forceRelayEnv,
          enabled: !!relayKeyBuf
        })
      } else {
        log('warn', 'relay info unavailable; hyperswarm will use direct connect + hole punch only')
        emit('relay:info', { pubkey: null, regions: [], forced: forceRelayEnv, enabled: false })
      }
    }).catch(() => { /* noop */ })

    // Auto-join the configured room's swarm topic. The renderer can also
    // trigger room:join to instantiate Autobases inside the room.
    await joinRoom(config.roomSlug)

    // Phase 1: auto-open the room's Autobases on the configured slug so that
    // two --seed:peer instances immediately share playhead + chat without the
    // renderer needing to click "Join". Renderer-driven room:join still works.
    await openRoomFor(config.roomSlug, config.isHost)
  } catch (err) {
    log('error', 'boot failed', { message: err.message, stack: err.stack })
    emit('error', { code: 'BOOT_FAILED', message: err.message })
    Bare.exit(1)
  }
})()

// -- incoming IPC ----------------------------------------------------------

pipe.on('data', async (data) => {
  const raw = data.toString()

  // Template OTA control string.
  if (raw === 'pear:applyUpdate') {
    if (!pear) {
      log('warn', 'applyUpdate requested but pear runtime is not initialized')
      pipe.write(b4a.from('pear:updateApplied'))
      return
    }
    try {
      await pear.updater.applyUpdate()
      pipe.write(b4a.from('pear:updateApplied'))
    } catch (err) {
      log('error', 'applyUpdate failed', { message: err.message })
    }
    return
  }

  // JSON message from renderer.
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    log('warn', 'non-json ipc', { raw: raw.slice(0, 200) })
    return
  }

  await dispatchCommand(msg)
})

async function dispatchCommand(msg) {
  const { id, cmd, payload } = msg || {}
  if (!cmd || typeof cmd !== 'string') {
    log('warn', 'ipc missing cmd', { msg })
    return
  }
  try {
    switch (cmd) {
      case 'room:join': {
        const slug = String(payload?.slug || config.roomSlug)
        const isHost = !!payload?.isHost
        await openRoomFor(slug, isHost)
        emit('ack', { id, cmd })
        return
      }
      case 'room:leave': {
        await closeCurrentRoom()
        emit('room:closed', {})
        emit('ack', { id, cmd })
        return
      }
      case 'playhead:set': {
        if (!room) throw new RoomNotJoinedError()
        const type = payload?.type
        const matchTimeMs = Number(payload?.matchTimeMs ?? payload?.match_time_ms)
        const rate = payload?.rate
        // T3: is_anchor is host-only. Non-hosts requesting is_anchor are
        // silently downgraded to a regular seek so peers cannot inject drift
        // corrections.
        const isAnchor = !!payload?.is_anchor && !!config.isHost
        await room.playhead.setState({
          type,
          match_time_ms: matchTimeMs,
          rate: typeof rate === 'number' ? rate : undefined,
          is_anchor: isAnchor
        })
        emit('ack', { id, cmd })
        return
      }
      case 'chat:send': {
        if (!room) throw new RoomNotJoinedError()
        const text = String(payload?.text ?? '')
        const matchTimeMs = Number(payload?.matchTimeMs ?? payload?.match_time_ms ?? 0)
        const lang = typeof payload?.lang === 'string' ? payload.lang : undefined
        const stored = await room.chat.send({ text, match_time_ms: matchTimeMs, lang })
        emit('ack', { id, cmd, payload: { key: stored.wall_clock_ms } })
        return
      }
      case 'chat:history': {
        if (!room) throw new RoomNotJoinedError()
        const from = Number(payload?.from ?? 0)
        const limit = Math.min(500, Math.max(1, Number(payload?.limit ?? 100)))
        const messages = await room.chat.history({ from, limit })
        emit('chat:history', { messages, requestId: id })
        emit('ack', { id, cmd })
        return
      }

      // -- clips ----------------------------------------------------------
      case 'clip:add': {
        if (!room) throw new RoomNotJoinedError()
        const buffer = decodeBase64(payload?.buffer)
        if (!buffer) throw new RangeError('buffer (base64) required')
        const matchTimeMs = Number(payload?.matchTimeMs ?? payload?.match_time_ms ?? 0)
        const caption = typeof payload?.caption === 'string' ? payload.caption : undefined
        try {
          const clip = await room.clips.addClip({ buffer, match_time_ms: matchTimeMs, caption })
          emit('clip:added', clip)
          emit('ack', { id, cmd, payload: { clipId: clip.clipId } })
        } catch (err) {
          if (err.code === 'CLIPS_CAP_EXCEEDED') {
            emit('clip:error', { code: err.code, message: err.message })
          }
          throw err
        }
        return
      }
      case 'clip:list': {
        if (!room) throw new RoomNotJoinedError()
        const limit = Math.min(500, Math.max(1, Number(payload?.limit ?? 200)))
        const clips = await room.clips.listClips({ limit })
        emit('clip:list', { clips, requestId: id })
        emit('ack', { id, cmd })
        return
      }
      case 'clip:get': {
        if (!room) throw new RoomNotJoinedError()
        const driveKey = String(payload?.driveKey || '')
        const path = String(payload?.path || '')
        try {
          const buf = await room.clips.getClip({ driveKey, path, byPeer: payload?.byPeer })
          emit('clip:data', {
            driveKey,
            path,
            buffer: encodeBase64(buf),
            requestId: id
          })
          emit('ack', { id, cmd })
        } catch (err) {
          emit('clip:error', { code: err.code || 'INTERNAL', message: err.message, driveKey, path })
          throw err
        }
        return
      }
      case 'clip:thumb': {
        if (!room) throw new RoomNotJoinedError()
        const coreKey = String(payload?.coreKey || '')
        const blobId = payload?.blobId
        try {
          const buf = await room.clips.getClipThumb({ coreKey, blobId })
          emit('clip:thumb', {
            coreKey,
            blobId,
            buffer: buf ? encodeBase64(buf) : null,
            requestId: id
          })
          emit('ack', { id, cmd })
        } catch (err) {
          emit('clip:thumb', { coreKey, blobId, buffer: null, error: err.message, requestId: id })
          throw err
        }
        return
      }
      case 'clip:track-peer': {
        if (!room) throw new RoomNotJoinedError()
        const peerPubkey = String(payload?.peerPubkey || '')
        const driveKey = String(payload?.driveKey || '')
        room.clips.trackPeerDrive(peerPubkey, driveKey)
        emit('ack', { id, cmd })
        return
      }

      // -- backend --------------------------------------------------------
      case 'backend:matches': {
        // Fix (2026-07-05): the RoomBrowser fires this call BEFORE the user
        // enters a room, so `room` is null at that point even though the
        // backend URL is configured. Fall back to a config-level client, the
        // same pattern used at lines 985 and 1500. Previous behavior emitted
        // `error: 'backend not configured'` on the first call, which the
        // RoomBrowser latched into a permanent "backend unreachable" banner.
        const client = room?.backend || (config.backendUrl
          ? createBackendClient(config.backendUrl, { lang: 'en' })
          : null)
        if (!client) {
          emit('backend:matches', { matches: [], error: 'backend not configured', requestId: id })
          return
        }
        const filters = payload?.filters || {}
        const useToday = payload?.today === true
        const res = useToday
          ? await client.getMatchesToday()
          : await client.listMatches(filters)
        emit('backend:matches', {
          matches: res.ok ? (res.data?.matches || res.data || []) : [],
          error: res.ok ? null : res.error,
          requestId: id
        })
        emit('ack', { id, cmd })
        return
      }
      case 'backend:rooms': {
        const client = room?.backend || (config.backendUrl
          ? createBackendClient(config.backendUrl, { lang: 'en' })
          : null)
        if (!client) {
          emit('backend:rooms', { rooms: [], error: 'backend not configured', requestId: id })
          return
        }
        const filters = payload?.filters || {}
        const res = await client.listRooms(filters)
        emit('backend:rooms', {
          rooms: res.ok ? (res.data?.rooms || res.data || []) : [],
          error: res.ok ? null : res.error,
          requestId: id
        })
        emit('ack', { id, cmd })
        return
      }
      case 'backend:publish-room': {
        if (!room?.backend) {
          emit('backend:publish-room', { ok: false, error: 'backend not configured', requestId: id })
          return
        }
        const identity = identityCache || (await getPeerIdentity())
        const res = await room.backend.publishRoom({
          slug: room.slug,
          matchId: payload?.matchId,
          hostHandle: payload?.hostHandle || identity.handle,
          hostSmartAddress: payload?.hostSmartAddress,
          hostOwnerAddress: payload?.hostOwnerAddress,
          expiresAt: payload?.expiresAt
        })
        emit('backend:publish-room', {
          ok: res.ok,
          data: res.data,
          error: res.error,
          requestId: id
        })
        emit('ack', { id, cmd })
        return
      }
      case 'distribution:get-key': {
        // Task 3/8: return the cached pear:// key + build an invite link.
        // If the slug is provided, we return a full invite link; otherwise
        // just the key. Never throws; a null key means fall back to curva://.
        const slug = typeof payload?.slug === 'string' ? payload.slug : null
        let key = getCachedPearAppKey()
        if (!key) {
          // Try one more time; the boot fetch may still be in-flight or
          // the backend may have come back online.
          key = await fetchPearAppKey(config.backendUrl).catch(() => null)
        }
        const link = slug
          ? (key
              ? key + '?room=' + encodeURIComponent(slug)
              : 'curva://room/' + encodeURIComponent(slug))
          : key
        emit('distribution:key', { key, link, slug, fallback: !key })
        emit('ack', { id, cmd })
        return
      }
      case 'backend:phrasebook': {
        // Task 4: read /phrasebook, pick a random quote per session, and
        // emit it back. The renderer caches per session.
        if (!room?.backend && config.backendUrl) {
          // If no room is open, fall through to a fresh backend client.
          try {
            const { createBackendClient } = require('../bare/backend.js')
            const client = createBackendClient(config.backendUrl, { lang: 'en' })
            const res = await client.getPhrasebook('en')
            emit('backend:phrasebook', {
              ok: res.ok,
              phrases: res.ok ? (res.data?.phrases || res.data || []) : [],
              error: res.error || null,
              requestId: id
            })
          } catch (err) {
            emit('backend:phrasebook', { ok: false, phrases: [], error: { message: err.message }, requestId: id })
          }
          emit('ack', { id, cmd })
          return
        }
        if (room?.backend) {
          const res = await room.backend.getPhrasebook(room.backend.lang)
          emit('backend:phrasebook', {
            ok: res.ok,
            phrases: res.ok ? (res.data?.phrases || res.data || []) : [],
            error: res.error || null,
            requestId: id
          })
          emit('ack', { id, cmd })
          return
        }
        emit('backend:phrasebook', { ok: false, phrases: [], error: { message: 'backend not configured' }, requestId: id })
        emit('ack', { id, cmd })
        return
      }
      case 'backend:leaderboard': {
        // Task 5: read /leaderboard?matchId=<id>. Returns top hosts.
        const matchId = typeof payload?.matchId === 'string' ? payload.matchId : null
        try {
          const { createBackendClient } = require('../bare/backend.js')
          const client = room?.backend || createBackendClient(config.backendUrl, { lang: 'en' })
          const qs = matchId ? '?matchId=' + encodeURIComponent(matchId) : ''
          // Use raw fetch through the client's baseUrl to avoid piling on the
          // backend client with a dedicated method for every one-off endpoint.
          const url = client.baseUrl + '/leaderboard' + qs
          const resp = await fetch(url, { headers: { Accept: 'application/json' } })
          const json = await resp.json().catch(() => null)
          if (!resp.ok || (json && json.success === false)) {
            emit('backend:leaderboard', {
              ok: false,
              rows: [],
              error: json?.error || { message: 'http ' + resp.status },
              requestId: id
            })
          } else {
            emit('backend:leaderboard', {
              ok: true,
              rows: json?.data?.rows || json?.data || [],
              matchId,
              requestId: id
            })
          }
        } catch (err) {
          emit('backend:leaderboard', {
            ok: false,
            rows: [],
            error: { message: err.message },
            requestId: id
          })
        }
        emit('ack', { id, cmd })
        return
      }
      case 'backend:activity-connect': {
        await connectActivityFeed()
        emit('ack', { id, cmd })
        return
      }
      case 'backend:activity-disconnect': {
        disconnectActivityFeed()
        emit('ack', { id, cmd })
        return
      }

      // -- Phase 3: wallet + tipping -------------------------------------
      case 'wallet:init': {
        await initWallet(payload || {})
        emit('ack', { id, cmd })
        return
      }
      case 'wallet:set-passcode': {
        // Renderer supplied a passcode from the first-run PasscodePrompt modal.
        // We treat this exactly like wallet:init with a passcode payload.
        // The passcode string is never emitted back or logged.
        const passcode = payload?.passcode
        if (typeof passcode !== 'string' || passcode.length < 6 || passcode.length > 128) {
          throw new RangeError('passcode must be 6-128 chars')
        }
        await initWallet({ passcode })
        emit('ack', { id, cmd })
        return
      }
      case 'wallet:info': {
        emit('wallet:info', walletInfoSnapshot())
        emit('ack', { id, cmd })
        return
      }
      case 'wallet:balance': {
        const balance = walletReady && wallet ? await wallet.getBalance() : '0'
        emit('wallet:balance', { balance, chainId: SEPOLIA.chainId })
        emit('ack', { id, cmd })
        return
      }
      case 'tip:propose': {
        if (!room?.tip) throw new TipNotReadyError()
        const amount = String(payload?.amount ?? DEMO_AMOUNT_BASE_UNITS)
        const note = typeof payload?.note === 'string' ? payload.note : undefined
        const row = await room.tip.proposeTip({ amount, note })
        emit('ack', { id, cmd, payload: { status: row.status, tx_hash: row.tx_hash } })
        return
      }
      case 'tip:list': {
        if (!room?.tip) {
          emit('tip:list', { tips: [], requestId: id })
          emit('ack', { id, cmd })
          return
        }
        const tips = await room.tip.listTips({ limit: Math.min(500, Number(payload?.limit) || 100) })
        emit('tip:list', { tips: tips.map(sanitizeTipRow), requestId: id })
        emit('ack', { id, cmd })
        return
      }

      // -- Phase 4 diagnostics -------------------------------------------
      case 'diag:latencies': {
        emit('diag:latencies', {
          samples: latencyTracker.list(),
          stats: latencyTracker.stats(),
          requestId: id
        })
        emit('ack', { id, cmd })
        return
      }
      case 'diag:health': {
        // Backend liveness probe from within the worker so the renderer's
        // dev-only diag panel can render the answer.
        let backendOk = false
        let backendStatus = 'unknown'
        try {
          const res = await room?.backend?.ping?.()
          backendOk = !!res?.ok
          backendStatus = res?.ok ? 'ok' : (res?.error?.code || 'unreachable')
        } catch (err) {
          backendStatus = err?.message || 'error'
        }
        emit('diag:health', {
          backendOk,
          backendStatus,
          swarmPeers: swarm.connections.size,
          walletReady,
          chainId: SEPOLIA.chainId,
          latency: latencyTracker.stats(),
          requestId: id
        })
        emit('ack', { id, cmd })
        return
      }

      // -- Phase 3.5: QVAC translation -----------------------------------
      case 'translate:init': {
        const targetLang = String(payload?.targetLang || 'en').toLowerCase()
        if (!['en', 'it', 'id'].includes(targetLang)) {
          throw new RangeError('targetLang must be en|it|id')
        }
        userTargetLang = targetLang
        // Fire-and-forget: init returns quickly with progress/ready events.
        ensureTranslator(targetLang).catch(() => { /* handled inside */ })
        emit('ack', { id, cmd, payload: { targetLang } })
        return
      }
      case 'translate:text': {
        if (!translator || !translationEnabled) {
          throw new TranslateDisabledCmdError()
        }
        const text = String(payload?.text || '')
        const from = String(payload?.from || '').toLowerCase()
        const to = String(payload?.to || '').toLowerCase()
        if (text.length === 0) throw new RangeError('text required')
        const translated = await translator.translate({ text, from, to })
        emit('translate:text', { translated, requestId: id })
        emit('ack', { id, cmd, payload: { translated } })
        return
      }
      case 'translate:status': {
        const st = translator ? translator.status() : {
          ready: false,
          disabled: !translationEnabled,
          disabledReason: 'not initialized',
          loaded: []
        }
        emit('translate:status', { ...st, targetLang: userTargetLang })
        emit('ack', { id, cmd })
        return
      }
      // Fix Wave C T4: integrity-badge state (loaded models + digests + a
      // per-session network-call counter, currently always 0 for pure
      // on-device translation).
      case 'translate:state': {
        const s = translator ? translator.state() : {
          loadedModels: [],
          mode: translationEnabled ? 'ready' : 'disabled',
          networkCallsThisSession: 0
        }
        emit('translate:state', { ...s, requestId: id })
        emit('ack', { id, cmd, payload: s })
        return
      }
      case 'translate:set-user-lang': {
        const lang = String(payload?.lang || '').toLowerCase()
        if (!['en', 'it', 'id'].includes(lang)) {
          throw new RangeError('lang must be en|it|id')
        }
        userTargetLang = lang
        emit('translate:user-lang', { targetLang: lang })
        emit('ack', { id, cmd })
        return
      }

      // -- Wave 8B: relay + seeder + live peer counts --------------------
      case 'relay:info': {
        // Return the current relay config snapshot. Never triggers a network
        // fetch — the boot fetch is authoritative.
        emit('relay:info', {
          pubkey: relayInfoCache?.pubkey || null,
          regions: relayInfoCache?.regions || [],
          forced: forceRelayEnv,
          enabled: !!relayKeyBuf,
          activeConnections: relayActiveConns.size,
          requestId: id
        })
        emit('ack', { id, cmd })
        return
      }
      case 'seeder:stats': {
        // Return a shallow snapshot. Renderer polls this every 30s from the
        // footer/RoomBrowser chip.
        const snap = seederStats.snapshot()
        emit('seeder:stats', { ...snap, requestId: id })
        emit('ack', { id, cmd })
        return
      }
      // Final Fix Wave T4: swarm suspend/resume. Called from the Electron
      // main process when the window is minimized/restored so we release DHT
      // sockets and stop discovery on backgrounding. See:
      //   https://github.com/holepunchto/hyperswarm  (suspend/resume)
      case 'swarm:suspend': {
        const result = await suspendSwarm(swarm)
        if (result.ok) log('info', 'swarm suspended', { note: result.note })
        else log('warn', 'swarm.suspend failed', { message: result.error })
        emit('swarm:suspended', { requestId: id, ...result })
        emit('ack', { id, cmd })
        return
      }
      case 'swarm:resume': {
        const result = await resumeSwarm(swarm)
        if (result.ok) log('info', 'swarm resumed', { note: result.note })
        else log('warn', 'swarm.resume failed', { message: result.error })
        emit('swarm:resumed', { requestId: id, ...result })
        emit('ack', { id, cmd })
        return
      }

      case 'peer-counts:live': {
        // Batch DHT peer-count lookup for a list of topics. Each topic must
        // be a 32-byte hex string. Rate limit + caching is enforced inside
        // peerCountLookup; we just await Promise.all.
        const topicsRaw = Array.isArray(payload?.topics) ? payload.topics : []
        // Reject unbounded batches. A full WC 2026 bracket is 104 fixtures.
        if (topicsRaw.length > 200) {
          throw new RangeError('too many topics (max 200)')
        }
        // Validate each entry at the boundary. Skip malformed silently rather
        // than aborting the whole batch — one bad topic must not poison the
        // list render.
        const validTopics = []
        for (const t of topicsRaw) {
          if (typeof t !== 'string') continue
          if (!/^[0-9a-f]{64}$/i.test(t)) continue
          validTopics.push(t.toLowerCase())
        }
        const results = await Promise.all(validTopics.map(async (t) => {
          const r = await peerCountLookup(t)
          return [t, r]
        }))
        // Emit as a plain object (Map does not survive JSON.stringify on the
        // wire; preload converts to a Map on the renderer side).
        const counts = {}
        for (const [t, r] of results) {
          counts[t] = { count: r.count, cached: !!r.cached, error: r.error || null }
        }
        emit('peer-counts:live', { counts, requestId: id })
        emit('ack', { id, cmd })
        return
      }

      // ===== PREDICTIONS (Wave 11) =====
      case 'predictions:config': {
        // Cheap sync-ish query for the renderer to decide whether to mount
        // PredictionPanel. Emits both the flag AND the "client-ready" bit so
        // the panel can render a "wallet required" placeholder when the flag
        // is on but the wallet has not been initialized yet.
        emit('predictions:config', {
          enabled: predictionsFlagEnabled,
          clientReady: !!room?.predictions,
          isHost: !!room?.isHost,
          requestId: id
        })
        emit('ack', { id, cmd })
        return
      }
      // All predictions:* handlers respect the feature flag AND require the
      // room's predictions client to be non-null (which room.js sets only when
      // the flag is on AND wallet + backend are both available). Every reject
      // path returns a structured error so the renderer can render a targeted
      // banner without leaking backend internals.
      case 'predictions:open': {
        if (!predictionsFlagEnabled) {
          emit('predictions:error', { code: 'FEATURE_DISABLED', message: 'Predictions feature disabled', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        if (!room?.predictions) {
          emit('predictions:error', { code: 'PREDICTIONS_NOT_READY', message: 'Predictions client not ready (wallet or backend missing?)', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        try {
          const result = await room.predictions.openPool({
            matchId: String(payload?.matchId || ''),
            mode: String(payload?.mode || 'winner-only'),
            entryStakeAtomic: payload?.entryStakeAtomic ? String(payload.entryStakeAtomic) : undefined,
            deadlineMs: Number(payload?.deadlineMs)
          })
          emit('predictions:opened', { ...result, requestId: id })
          emit('ack', { id, cmd, payload: { poolId: result.poolId } })
        } catch (err) {
          emit('predictions:error', {
            code: err.code || 'PREDICTIONS_OPEN_FAILED',
            message: err.message,
            requestId: id
          })
          emit('ack', { id, cmd })
        }
        return
      }
      case 'predictions:submit': {
        if (!predictionsFlagEnabled) {
          emit('predictions:error', { code: 'FEATURE_DISABLED', message: 'Predictions feature disabled', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        if (!room?.predictions) {
          emit('predictions:error', { code: 'PREDICTIONS_NOT_READY', message: 'Predictions client not ready', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        try {
          const result = await room.predictions.submitPrediction({
            poolId: String(payload?.poolId || ''),
            winner: String(payload?.winner || ''),
            homeGoals: payload?.homeGoals,
            awayGoals: payload?.awayGoals,
            stakeAtomic: String(payload?.stakeAtomic || ''),
            poolAddress: String(payload?.poolAddress || ''),
            chainId: Number(payload?.chainId),
            stakeToken: String(payload?.stakeToken || ''),
            mode: String(payload?.mode || 'winner-only')
          })
          emit('predictions:submitted', { ...result, requestId: id })
          emit('ack', { id, cmd, payload: { txHash: result.txHash } })
        } catch (err) {
          emit('predictions:error', {
            code: err.code || 'PREDICTIONS_SUBMIT_FAILED',
            message: err.message,
            requestId: id
          })
          emit('ack', { id, cmd })
        }
        return
      }
      case 'predictions:result': {
        if (!predictionsFlagEnabled) {
          emit('predictions:error', { code: 'FEATURE_DISABLED', message: 'Predictions feature disabled', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        if (!room?.predictions) {
          emit('predictions:error', { code: 'PREDICTIONS_NOT_READY', message: 'Predictions client not ready', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        try {
          const result = await room.predictions.publishResult({
            poolId: String(payload?.poolId || ''),
            winner: String(payload?.winner || ''),
            homeGoals: Number(payload?.homeGoals),
            awayGoals: Number(payload?.awayGoals),
            matchId: typeof payload?.matchId === 'string' ? payload.matchId : undefined
          })
          emit('predictions:result-published', { ...result, requestId: id })
          emit('ack', { id, cmd })
        } catch (err) {
          emit('predictions:error', {
            code: err.code || 'PREDICTIONS_RESULT_FAILED',
            message: err.message,
            requestId: id
          })
          emit('ack', { id, cmd })
        }
        return
      }
      case 'predictions:status': {
        if (!predictionsFlagEnabled) {
          emit('predictions:status', { exists: false, error: { code: 'FEATURE_DISABLED' }, requestId: id })
          emit('ack', { id, cmd })
          return
        }
        if (!room?.predictions) {
          emit('predictions:status', { exists: false, error: { code: 'PREDICTIONS_NOT_READY' }, requestId: id })
          emit('ack', { id, cmd })
          return
        }
        try {
          const snap = await room.predictions.getPoolStatus({
            matchId: String(payload?.matchId || ''),
            forceRefresh: !!payload?.forceRefresh
          })
          emit('predictions:status', { ...snap, requestId: id })
          emit('ack', { id, cmd })
        } catch (err) {
          emit('predictions:status', {
            exists: false,
            error: { code: err.code || 'PREDICTIONS_STATUS_FAILED', message: err.message },
            requestId: id
          })
          emit('ack', { id, cmd })
        }
        return
      }
      case 'predictions:announce-payout': {
        // Host-side helper: fired when SSE surfaces a prediction.payout event
        // that the renderer has correlated with a pool the host runs. Appends
        // system:pool-payout to chat so peers see the payout inline.
        if (!predictionsFlagEnabled || !room?.predictions) {
          emit('ack', { id, cmd })
          return
        }
        try {
          await room.predictions.announcePayout({
            matchId: String(payload?.matchId || ''),
            txHash: String(payload?.txHash || ''),
            toAddress: String(payload?.toAddress || ''),
            amountAtomic: String(payload?.amountAtomic || '')
          })
          emit('ack', { id, cmd })
        } catch (err) {
          emit('predictions:error', {
            code: err.code || 'PREDICTIONS_PAYOUT_FAILED',
            message: err.message,
            requestId: id
          })
          emit('ack', { id, cmd })
        }
        return
      }
      // ===== END PREDICTIONS =====

      // ===== QVAC COMMENTATOR (Wave 13A) =====
      case 'commentator:config': {
        emit('commentary:config', {
          enabled: commentatorFlagEnabled,
          isHost: !!config.isHost,
          modelLoaded: !!commentator?.status?.().modelLoaded,
          streaming: !!commentator?.status?.().streaming,
          tone: commentator?.status?.().tone || 'italian-ultras',
          requestId: id
        })
        emit('ack', { id, cmd })
        return
      }
      case 'commentator:enable': {
        if (!commentatorFlagEnabled) {
          emit('commentary:error', { code: 'FEATURE_DISABLED', message: 'commentator feature disabled', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        if (!config.isHost) {
          emit('commentary:error', { code: 'NOT_HOST', message: 'only the host may enable commentator', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        const c = ensureCommentator()
        if (!c) {
          emit('commentary:error', { code: 'COMMENTATOR_NOT_READY', message: 'commentator not initializable (no room?)', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        try {
          const st = await c.enable()
          emit('commentary:status', { ...st, requestId: id })
          emit('ack', { id, cmd })
        } catch (err) {
          emit('commentary:error', { code: err?.code || 'ENABLE_FAILED', message: err?.message || 'enable failed', requestId: id })
          emit('ack', { id, cmd })
        }
        return
      }
      case 'commentator:disable': {
        if (commentator) commentator.disable()
        emit('commentary:status', { ...(commentator?.status?.() || { enabled: false }), requestId: id })
        emit('ack', { id, cmd })
        return
      }
      case 'commentator:set-tone': {
        if (!commentator) {
          emit('commentary:error', { code: 'COMMENTATOR_NOT_READY', message: 'commentator not initialized', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        try {
          commentator.setTone(String(payload?.tone || ''))
          emit('ack', { id, cmd })
        } catch (err) {
          emit('commentary:error', { code: err?.code || 'VALIDATION_ERROR', message: err?.message, requestId: id })
          emit('ack', { id, cmd })
        }
        return
      }
      case 'commentator:status': {
        const st = commentator?.status?.() || {
          enabled: false,
          modelLoaded: false,
          streaming: false,
          tone: 'italian-ultras',
          isHost: !!config.isHost,
          lastError: null
        }
        emit('commentary:status', { ...st, requestId: id })
        emit('ack', { id, cmd })
        return
      }
      // ===== END QVAC COMMENTATOR =====

      // ===== WDK X402 (Wave 13B) =====
      case 'x402:fetch': {
        // Kick off a paid GET. The Bare wallet must be initialized (room.wallet
        // exists after openRoomFor); if not, we cannot sign so we reject with
        // WALLET_NOT_READY. The renderer will see this classified error via
        // the promise rejection and can surface a "connect wallet first" toast.
        if (!x402FlagEnabled) {
          emit('x402:error', { code: 'FEATURE_DISABLED', message: 'x402 feature disabled', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        const wallet = room?.wallet
        if (!wallet || typeof wallet.signEip3009 !== 'function') {
          emit('x402:error', { code: 'WALLET_NOT_READY', message: 'wallet not initialized', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        const url = String(payload?.url || '')
        if (!/^https?:\/\//i.test(url) || url.length > 1024) {
          emit('x402:error', { code: 'BAD_URL', message: 'url must be http(s) and <=1024 chars', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        x402PurgeStalePrompts()
        try {
          const client = createX402Client({
            wallet,
            emit: (name, p) => {
              // Attach requestId to every paywall event so the renderer's
              // confirm() call routes back to the right pending prompt.
              if (name === 'x402:paywall') emit(name, { ...p, requestId: id })
            },
            promptUser: (challenge) => new Promise((resolve, reject) => {
              x402PendingPrompts.set(id, {
                resolve, reject, createdAt: Date.now(),
                challenge
              })
            })
          })
          const result = await client.fetchPaid(url)
          emit('x402:unlocked', {
            url, resource: result.body?.data?.resource || null,
            txHash: result.txHash || null, replay: !!result.replay,
            requestId: id
          })
          emit('ack', { id, cmd, payload: result })
        } catch (err) {
          emit('x402:error', {
            code: err.code || 'X402_FAILED',
            message: err.message,
            requestId: id
          })
          emit('ack', { id, cmd })
        } finally {
          x402PendingPrompts.delete(id)
        }
        return
      }
      case 'x402:confirm': {
        // Renderer answers a pending paywall. If the id isn't known (expired
        // or already answered), silently ack so the renderer's UI can retry
        // without a spurious error.
        const promptId = String(payload?.id || '')
        const approved = !!payload?.approved
        const pending = x402PendingPrompts.get(promptId)
        if (pending) {
          x402PendingPrompts.delete(promptId)
          try { pending.resolve(approved) } catch (_) { /* noop */ }
        }
        emit('ack', { id, cmd })
        return
      }
      // ===== END WDK X402 =====

      // ===== ATTENDANCE (Wave 14) =====
      case 'attendance:issue': {
        if (!attendanceFlagEnabledInWorker) {
          emit('attendance:error', { code: 'FEATURE_DISABLED', message: 'Attendance feature disabled', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        if (!room?.attendance) {
          emit('attendance:error', { code: 'ATTENDANCE_NOT_READY', message: 'Attendance service unavailable (not host or wallet missing)', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        const peerAddress = String(payload?.peerAddress || '')
        if (!/^0x[0-9a-fA-F]{40}$/.test(peerAddress)) {
          emit('attendance:error', { code: 'VALIDATION_ERROR', message: 'peerAddress required (0x + 20 hex bytes)', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        const force = !!payload?.force
        const res = await room.attendance.issuePass(peerAddress, { force })
        if (!res.ok) {
          emit('attendance:error', { code: res.reason || 'ISSUE_FAILED', message: 'issue failed', requestId: id })
        } else {
          emit('attendance:issued', { pass: sanitizeAttendancePass(res.pass), cached: !!res.cached, requestId: id })
        }
        emit('ack', { id, cmd })
        return
      }
      case 'attendance:list': {
        if (!attendanceFlagEnabledInWorker) {
          emit('attendance:list', { passes: [], error: { code: 'FEATURE_DISABLED' }, requestId: id })
          emit('ack', { id, cmd })
          return
        }
        if (!room?.attendance) {
          emit('attendance:list', { passes: [], error: { code: 'ATTENDANCE_NOT_READY' }, requestId: id })
          emit('ack', { id, cmd })
          return
        }
        const limit = Math.min(500, Math.max(1, Number(payload?.limit) || 200))
        const passes = await room.attendance.listPasses({ limit })
        emit('attendance:list', {
          passes: passes.map(sanitizeAttendancePass),
          requestId: id
        })
        emit('ack', { id, cmd })
        return
      }
      case 'attendance:config': {
        emit('attendance:config', {
          enabled: attendanceFlagEnabledInWorker,
          isHost: !!config.isHost,
          clientReady: !!room?.attendance,
          requestId: id
        })
        emit('ack', { id, cmd })
        return
      }
      // ===== END ATTENDANCE =====

      // ===== BLIND PEERING (Wave 15) =====
      case 'blindPeering:status': {
        try {
          const st = blindPeering.status()
          emit('blindPeering:status', { ...st, requestId: id })
        } catch (err) {
          emit('blindPeering:status', {
            enabled: false,
            active: false,
            peerKeyShort: null,
            registrationsCount: 0,
            lastError: err?.message || 'status-failed',
            requestId: id
          })
        }
        emit('ack', { id, cmd })
        return
      }
      // ===== END BLIND PEERING (Wave 15) =====

      default:
        log('info', 'ipc unknown cmd (ignored)', { cmd, id })
    }
  } catch (err) {
    log('warn', 'ipc dispatch failed', { cmd, message: err.message })
    emit('error', {
      cmd,
      id,
      code: err.code || (err instanceof RangeError ? 'VALIDATION_ERROR' : 'INTERNAL'),
      message: err.message
    })
  }
}

class RoomNotJoinedError extends Error {
  constructor() {
    super('room not joined')
    this.code = 'ROOM_NOT_JOINED'
  }
}

class TranslateDisabledCmdError extends Error {
  constructor() {
    super('translation is disabled or not initialized')
    this.code = 'TRANSLATION_DISABLED'
  }
}

function decodeBase64(str) {
  if (!str || typeof str !== 'string') return null
  try {
    return b4a.from(str, 'base64')
  } catch { return null }
}

function encodeBase64(buf) {
  if (!buf) return ''
  return b4a.toString(buf, 'base64')
}

// -- shutdown --------------------------------------------------------------

goodbye(async () => {
  log('info', 'shutting down')
  disconnectActivityFeed()
  try {
    if (translator) await translator.close()
  } catch (err) {
    log('warn', 'translator close failed', { message: err.message })
  }
  // Wave 13A: close commentator (unloads LLM model if loaded).
  try {
    if (commentatorGoalUnsub) commentatorGoalUnsub()
    if (commentator) await commentator.close()
  } catch (err) {
    log('warn', 'commentator close failed', { message: err.message })
  }
  try {
    await closeCurrentRoom()
  } catch (err) {
    log('warn', 'closeCurrentRoom failed', { message: err.message })
  }
  try {
    if (roomDiscovery) await roomDiscovery.destroy()
  } catch (err) {
    log('warn', 'discovery destroy failed', { message: err.message })
  }
  // Wave 15: close blind-peering BEFORE the swarm so it can release channels
  // cleanly per the docs ("must be called before closing the room and swarm").
  try {
    if (blindPeering) await blindPeering.close()
  } catch (err) {
    log('warn', 'blind-peering close failed', { message: err.message })
  }
  try {
    await swarm.destroy()
  } catch (err) {
    log('warn', 'swarm destroy failed', { message: err.message })
  }
  if (pear) {
    try {
      await pear.close()
    } catch (err) {
      log('warn', 'pear close failed', { message: err.message })
    }
  }
  try {
    await store.close()
  } catch (err) {
    log('warn', 'store close failed', { message: err.message })
  }
})
