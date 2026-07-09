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

// Bare-runtime compatibility: install ALL Node-compatible globals in one call.
// `bare-node-runtime/global` sets up fetch, Request, Response, Headers,
// AbortController, TextEncoder, TextDecoder, ReadableStream, WritableStream,
// EventTarget, WebSocket, crypto, performance, and (importantly) it also
// installs a `process` global whose `versions.node` is spoofed to '20.0.0'
// so downstream libraries that gate on Node version checks (ethers, WDK,
// @noble/*) treat this runtime as Node 20-compatible.
//
// This must be the first executable statement in the worker. Downstream
// modules require these globals to already be present.
require('bare-node-runtime/global')

// Curva historically polyfilled `process.env` via `bare-env`. bare-process
// (loaded transitively by bare-node-runtime/global) already exposes
// `process.env` backed by the same underlying bare-os getEnv, so this is now
// a no-op, but keep the guard so existing downstream modules that were
// written against the older polyfill continue to work.
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
const {
  handleFromPubkey,
  setKeetIdentity
} = require('../bare/identity.js')
// Tier 4 Round 2 keet portable identity.
const {
  createKeetIdentity,
  featureEnabled: keetIdentityFeatureEnabled
} = require('../bare/keetIdentity.js')
const { openRoom } = require('../bare/room.js')
const { createBackendClient } = require('../bare/backend.js')
const { createTranslator } = require('../bare/translate.js')
const { readSourceLang } = require('../bare/chat.js')
const { createWalletAdapter } = require('../bare/wallet/worklet.js')
const { SEPOLIA, DEMO_AMOUNT_BASE_UNITS } = require('../bare/wallet/eip3009.js')
const { createLatencyTracker } = require('../bare/diagnostics.js')
const { suspendSwarm, resumeSwarm } = require('../bare/swarmLifecycle.js')
// pear.assets branding pack: expose Pear.app.assets.branding.path to renderer.
// See bare/assets.js and branding-drive/PUBLISH.md.
const { getBrandingPath, getBrandingBytes } = require('../bare/assets.js')
// Feature 1 (WC reel): read the local clip into Hyperdrive at room open.
// Feature 2 (identity chip): decode identity_proof -> identityPublicKey.
let IdentityKey = null
try { IdentityKey = require('keet-identity-key') } catch { /* optional */ }
let bareFs = null
try { bareFs = require('bare-fs') } catch { try { bareFs = require('fs') } catch { /* noop */ } }
let barePath = null
try { barePath = require('bare-path') } catch { try { barePath = require('path') } catch { /* noop */ } }

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

// pear.assets branding pack: re-read the drive path and broadcast. Called
// once at boot and on every 'assets:refresh' IPC. Safe to call before the
// drive has landed; payload.path will be null and the renderer keeps its
// bundled fallback.
function emitBrandingSnapshot() {
  const path = getBrandingPath()
  const bytes = getBrandingBytes()
  emit('assets:branding', { path, bytes })
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
  let replicateStream = null
  try { replicateStream = store.replicate(conn) } catch (err) {
    console.error('[Curva] store.replicate failed:', err?.message)
  }
  // Autobase writer core attachment. `store.replicate(conn)` above only
  // attaches cores with `active: true`; Autobase opens writer cores with
  // `active: false`, so without an explicit `base.replicate(conn)` the
  // writer cores never attach to this connection's muxer and chat blocks
  // authored on either side never cross. Piggybacks on the same noise
  // stream — idempotent when the room is opened later (openRoomFor also
  // runs this loop for the current room state).
  if (room) {
    try { if (room.chat?.getBase?.()?.replicate) room.chat.getBase().replicate(conn) } catch (err) {
      log('warn', 'chat autobase attach on connect failed', { message: err && err.message })
    }
    try { if (room.playhead?.getBase?.()?.replicate) room.playhead.getBase().replicate(conn) } catch (err) {
      log('warn', 'playhead autobase attach on connect failed', { message: err && err.message })
    }
  }
  // Tier 3: tactical drawing channel rides the same corestore-replicate
  // Protomux. `room.attachTacticalToStream` grabs the existing muxer via
  // Hypercore.getProtocolMuxer(stream) and adds `curva/tactical/1` alongside
  // the existing corestore channels. Never wraps the raw socket. See
  // bare/tacticalChannel.js resolveMuxer for the docs-verified pattern.
  if (room && replicateStream) {
    try { room.attachTacticalToStream(replicateStream, conn) } catch (err) {
      log('warn', 'tactical attach failed', { peer: info?.publicKey && b4a.toString(info.publicKey, 'hex').slice(0, 8), error: err?.message })
    }
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
    // Tier 3: release the tactical channel handle for this connection so the
    // room does not leak Protomux subscriptions.
    if (room) {
      try { room.detachTacticalForConn(conn) } catch { /* noop */ }
    }
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
let localWriterActiveSessions = [] // retained hypercore sessions that keep local writer cores replicable
// Guard against re-entrant room reopens triggered by `room:hello` frames
// arriving on multiple concurrent connections. Non-null while a reopen is in
// flight; the awaiter clears it in a finally.
let roomBootstrapReopenInFlight = null
let identityCache = null        // { pubkey, handle }
let wallet = null               // wallet adapter (once initialized)
let walletReady = false

// Tier 4 Round 2: keet portable identity handle. Populated when the
// CURVA_KEET_IDENTITY_ENABLED flag is on AND the wallet passcode has been
// supplied (same passcode unlocks both blobs, distinct namespaced keys).
// Consumers pull via bare/identity.js getKeetIdentity(); we also keep a
// module-scoped alias for the IPC cases below.
let keetIdentity = null
let keetIdentityPasscode = null // held in-memory so restore/generate IPC can reuse
let cachedHostAddresses = null  // { smartAddress, ownerAddress } discovered from room state
let demoAutoTipFired = false     // guard: fire the E2E auto-tip at most once per boot

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
// Wave 14: Whisper STT captions. Independent of the commentator LLM flag so a
// host can ship captions without paying the LLM download cost (or vice versa).
const sttFlagEnabled = (() => {
  try {
    const v = (typeof process !== 'undefined' && process.env && process.env.CURVA_QVAC_STT_ENABLED) || ''
    const s = String(v).toLowerCase()
    return s === '1' || s === 'true' || s === 'yes' || s === 'on'
  } catch { return false }
})()
log('info', 'commentator feature flag', { enabled: commentatorFlagEnabled })
log('info', 'commentator STT feature flag', { enabled: sttFlagEnabled })

let commentator = null
let commentatorGoalUnsub = null

// ===== QVAC ROOM BOT (Wave 13B) =====
// `/bot <prompt>` in chat routes through Qwen3 + curva-mcp HTTP transport.
// Shares the LLM handle with the commentator when both flags are on: the
// commentator loads Qwen3 with modelConfig.tools = true and roomBot reuses
// the same modelId via getSharedLlmHandle(). When only roomBot is on, it
// loads its own copy of the model with tools:true. Feature flag:
// CURVA_QVAC_BOT_ENABLED (default false). See bare/roomBot.js for the
// docs-verification memo + MCP HTTP client adapter.
const { createRoomBot, botFlagEnabled: readBotFlag } = require('../bare/roomBot.js')
const botFlagEnabled = (() => {
  try { return readBotFlag() } catch { return false }
})()
log('info', 'roomBot feature flag', { enabled: botFlagEnabled })
let roomBot = null
let roomBotChatUnsub = null
// ===== END QVAC ROOM BOT =====

// ===== SUPERTONIC TTS GOAL ANNOUNCER (Tier 4) =====
// Multilingual goal announcements via Supertonic 3. Off by default: reads
// CURVA_QVAC_TTS_ENABLED at process start. The model is ~121 MB and is only
// loaded once .enable() is called (which we drive lazily from the goal hook
// below when the flag is on). Fire-and-forget from the goal event path so
// TTS latency never blocks event propagation. Docs verified in
// pear-app/bare/announcer.js head memo.
const {
  createAnnouncer: createTtsAnnouncer,
  announcerFlagEnabled: readAnnouncerFlag
} = require('../bare/announcer.js')
const announcerFlagEnabled = (() => {
  try { return readAnnouncerFlag() } catch { return false }
})()
const announcerLocalesEnv = (() => {
  const raw = (typeof process !== 'undefined' && process.env &&
    process.env.CURVA_QVAC_TTS_LOCALES) || ''
  const arr = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return arr.length > 0 ? arr : null
})()
const announcerDefaultLocale = (() => {
  const raw = (typeof process !== 'undefined' && process.env &&
    process.env.CURVA_QVAC_TTS_LOCALE) || 'en'
  return String(raw).toLowerCase().slice(0, 2) || 'en'
})()
log('info', 'announcer feature flag', {
  enabled: announcerFlagEnabled,
  defaultLocale: announcerDefaultLocale,
  locales: announcerLocalesEnv
})

let announcer = null
let announcerEnablePromise = null

function ensureAnnouncer () {
  if (announcer) return announcer
  if (!announcerFlagEnabled) return null
  announcer = createTtsAnnouncer({
    storageDir: config.dir,
    isHost: !!config.isHost,
    chat: room?.chat || null,
    phrasebookUrl: config.backendUrl
      ? config.backendUrl.replace(/\/$/, '') + '/phrasebook'
      : null,
    log,
    emit
  })
  const locales = announcerLocalesEnv || [announcerDefaultLocale]
  announcerEnablePromise = announcer.enable({ locales, defaultLocale: announcerDefaultLocale })
    .then((res) => {
      log('info', 'announcer enable result', res)
      return res
    })
    .catch((err) => {
      log('warn', 'announcer enable failed', { message: err && err.message })
      return { enabled: false, reason: err && err.message }
    })
  return announcer
}
// ===== END SUPERTONIC TTS GOAL ANNOUNCER =====

function ensureCommentator() {
  if (commentator) return commentator
  if (!commentatorFlagEnabled) return null
  if (!room?.chat) return null
  // Wave 13B: when the roomBot is on, we MUST load Qwen3 with modelConfig
  // tools:true so the shared handle can drive MCP tool-calls. The commentator
  // path does not need tools by itself, so we only pass the flag when the
  // roomBot piggy-backs on the load.
  const modelConfig = botFlagEnabled ? { tools: true } : null
  commentator = createCommentator({
    storageDir: config.dir,
    isHost: !!config.isHost,
    chat: room.chat,
    modelConfig,
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
  // Wave 14: opt-in Whisper STT captions. Off by default. When the host sets
  // CURVA_QVAC_STT_ENABLED, spin up a transcribeStream() session using the
  // WAV fallback (or bare-audio live capture once that addon ships) and
  // broadcast every VAD-segmented text event as a `system:caption` message.
  // Failure is non-fatal: the commentator LLM path continues regardless.
  if (config.isHost && sttFlagEnabled) {
    const sttLang = (typeof process !== 'undefined' && process.env && process.env.CURVA_COMMENTATOR_STT_LANG) || 'en'
    commentator.enableSTT({
      lang: sttLang,
      preferLive: false,
      getMatchTimeMs: () => {
        try {
          const st = room?.playhead?.state?.() || {}
          return Math.max(0, Number(st.match_time_ms || 0))
        } catch { return 0 }
      }
    }).then((res) => {
      log('info', 'commentator STT enable result', res)
    }).catch((err) => {
      log('warn', 'commentator STT enable failed', { message: err?.message })
    })
  }
  return commentator
}

async function ensureRoomBot () {
  if (roomBot) return roomBot
  if (!botFlagEnabled) return null
  if (!room?.chat) return null

  // Prefer the commentator's already-loaded Qwen3 when available. When the
  // commentator flag is off (or the model hasn't landed yet), roomBot loads
  // its own copy of QWEN3_600M_INST_Q4 with modelConfig.tools = true.
  let sharedLlmHandle = null
  try {
    if (commentator && typeof commentator.getSharedLlmHandle === 'function') {
      sharedLlmHandle = commentator.getSharedLlmHandle()
    }
  } catch (_) { sharedLlmHandle = null }

  // Semifinal QVAC depth: wire an in-process MCP tool client so the bot can
  // call Curva-native tools (getMatchState, getRoomStats, getRecentTips,
  // translateText) alongside the backend companion server. Also wire a RAG
  // instance so completion() answers are grounded on the room's glossary +
  // chat history.
  const roomMcp = ensureMcpTools()
  const rag = await ensureRag()
  // Fire-and-forget: ingest the football glossary once per room boot. The
  // embed model download is a one-time ~200 MB cost; the promise settles in
  // the background so roomBot enable does not block.
  ingestGlossaryOnce().catch((err) => log('info', 'rag glossary ingest deferred', { message: err && err.message }))

  roomBot = createRoomBot({
    chat: room.chat,
    backendUrl: config.backendUrl || 'http://localhost:3700',
    authToken: (typeof process !== 'undefined' && process.env && process.env.CURVA_MCP_ACCESS_TOKEN) || null,
    sharedLlmHandle,
    isHost: !!config.isHost,
    flagEnabled: true,     // ensureRoomBot only runs when botFlagEnabled is true
    emit: (event, payload) => emit(event, payload),
    log,
    roomSlug: config.roomSlug || 'default',
    roomMcpClient: (roomMcp && roomMcp.client) || null,
    rag: rag
  })

  try {
    await roomBot.enable()
  } catch (err) {
    log('warn', 'roomBot enable failed', { message: err && err.message })
  }

  // Subscribe to chat: any peer's `msg` starting with "/bot " triggers the
  // roomBot. Only ONE peer per room actually runs the bot (whoever set the
  // flag), so duplicate replies are naturally suppressed by the opt-in model.
  if (typeof room.chat.onMessage === 'function') {
    roomBotChatUnsub = room.chat.onMessage((m) => {
      if (!m || m.type !== 'msg' || typeof m.text !== 'string') return
      if (!m.text.startsWith('/bot ')) return
      const prompt = m.text.slice(5).trim()
      if (prompt.length === 0) return
      // Fire-and-forget. answer() enforces its own rate-limit per peer, so
      // even a chat storm cannot back-pressure the writer.
      roomBot.answer(prompt, {
        sourcePeer: m.by_peer || '',
        recentChat: recentChatRing.slice(-6),
        matchTimeMs: Number(m.match_time_ms) || 0
      }).catch((err) => log('warn', 'roomBot answer threw', { message: err && err.message }))
    })
  }
  return roomBot
}

// ===== SEMIFINAL QVAC DEPTH: RAG + MCP + DELEGATED =====
//
// These three modules are lazy-init: they are only constructed when their
// first IPC command arrives (or when roomBot needs them). This keeps the room
// open cost the same for users who don't use the semifinal features while
// making the code path discoverable and testable for judges.
const { createRag, glossaryToDocuments } = require('../bare/rag.js')
const { createMcpToolsClient } = require('../bare/mcpTools.js')
const { createDelegatedRegistry } = require('../bare/delegatedProvider.js')
const roomGlossary = (() => {
  try { return require('../bare/glossary.json') } catch { return { terms: [] } }
})()

let ragInstance = null
let ragGlossaryIngested = false
async function ensureRag () {
  if (ragInstance) return ragInstance
  ragInstance = createRag({
    roomSlug: config.roomSlug || 'default',
    emit: (ev, p) => emit(ev, p),
    log
  })
  return ragInstance
}
async function ingestGlossaryOnce () {
  if (ragGlossaryIngested) return
  const rag = await ensureRag()
  const ready = await rag.ensureReady()
  if (!ready) return
  const docs = glossaryToDocuments(roomGlossary, { limit: 200 })
  if (docs.length === 0) return
  const res = await rag.ingest(docs, { kind: 'glossary' })
  if (res && res.ok) ragGlossaryIngested = true
}

let mcpToolsInstance = null
function ensureMcpTools () {
  if (mcpToolsInstance) return mcpToolsInstance
  // The module-level `translator` is populated lazily by createTranslator();
  // wrap it in an accessor so the MCP tool always reads the current instance
  // rather than a stale reference captured at ensureMcpTools() time.
  const translatorRef = {
    translate: async (opts) => {
      if (translator && typeof translator.translate === 'function') {
        return translator.translate(opts)
      }
      // Fall back to the raw text so the tool never throws.
      return opts && opts.text ? String(opts.text) : ''
    }
  }
  // Adapt the Curva room's actual surface to the shape createMcpToolsClient
  // expects. The mcpTools module treats these as optional accessors, so
  // missing subsystems degrade to safe zeros rather than throwing.
  const roomAdapter = {
    playhead: (room && room.playhead) || null,
    swarm,
    identity: {
      verifiedPeerCount: () => (room && typeof room.getVerifiedCount === 'function') ? room.getVerifiedCount() : 0
    },
    chat: {
      count: () => recentChatRing.length
    }
  }
  mcpToolsInstance = createMcpToolsClient({
    room: roomAdapter,
    translator: translatorRef,
    startedAt: Date.now(),
    log
  })
  return mcpToolsInstance
}

let delegatedRegistry = null
function ensureDelegatedRegistry () {
  if (delegatedRegistry) return delegatedRegistry
  delegatedRegistry = createDelegatedRegistry({
    roomState: (typeof room === 'object' && room && room.state) || null,
    ownerDeviceProof: null,
    emit: (ev, p) => emit(ev, p),
    log,
    onStatus: (evt) => emit('delegated:status', evt)
  })
  return delegatedRegistry
}
// ===== END SEMIFINAL QVAC DEPTH =====

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

  // Semifinal QVAC depth: opportunistically ingest each new chat line into
  // the RAG "chat" workspace so subsequent /bot queries can reference it.
  // Best-effort — do NOT block or throw. The RAG module already caps the
  // per-room workspace document count.
  const rawText = typeof msg.text === 'string' ? msg.text.trim() : ''
  if (rawText.length >= 6 && rawText.length <= 400 && !rawText.startsWith('/bot ')) {
    const author = msg.handle || (msg.by_peer ? String(msg.by_peer).slice(0, 8) : 'anon')
    const doc = author + ' said: ' + rawText
    if (ragInstance) {
      ragInstance.ingest([doc], { kind: 'chat' })
        .catch(() => { /* best effort */ })
    }
  }
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

// ===== DEMO MODE (D1/D2) =====
// Flag hierarchy per memory/impl_attendance_prediction.md:
//   - CURVA_DEMO_MODE (master, default false)
//   - CURVA_ATTENDANCE_AUTOISSUE (defaults to master when unset)
//   - CURVA_PREDICTIONS_AUTOOPEN (defaults to master when unset)
// The per-feature enable flags (CURVA_ATTENDANCE_ENABLED,
// CURVA_PREDICTIONS_ENABLED) still gate module instantiation upstream. These
// demo flags only decide whether the auto-fire playhead hook in room.js runs.
function readBoolFlagFromEnv(name, fallback) {
  try {
    const raw = (typeof process !== 'undefined' && process.env && process.env[name])
    if (raw === undefined || raw === null || raw === '') return fallback
    return String(raw).toLowerCase() === 'true'
  } catch { return fallback }
}
const demoMasterEnabled = readBoolFlagFromEnv('CURVA_DEMO_MODE', false)
const attendanceAutoIssueEnabled = readBoolFlagFromEnv('CURVA_ATTENDANCE_AUTOISSUE', demoMasterEnabled)
const predictionsAutoOpenEnabled = readBoolFlagFromEnv('CURVA_PREDICTIONS_AUTOOPEN', demoMasterEnabled)
log('info', 'demo mode flags', {
  demoMaster: demoMasterEnabled,
  attendanceAutoIssue: attendanceAutoIssueEnabled,
  predictionsAutoOpen: predictionsAutoOpenEnabled
})
// ===== END DEMO MODE =====

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

async function openRoomFor(slug, isHost, { chatBootstrap = null, playheadBootstrap = null } = {}) {
  if (room) {
    log('warn', 'openRoomFor called while room exists; closing prior room first')
    await closeCurrentRoom()
  }
  // Join the Hyperswarm topic FIRST so the peer is discoverable + can discover
  // others on this room's topic. Without this, `--no-auto-open` boots (lobby
  // then click-Join flow) never announce the room topic on the DHT, and the
  // two peers never find each other even when both open the same Autobase.
  // Idempotent: hyperswarm de-duplicates `join(topic)` calls on the same
  // discovery instance; a repeat join here is a no-op. Best-effort — a DHT
  // announce failure should not block room open (the swarm keeps retrying
  // in the background).
  try {
    if (!roomDiscovery || roomDiscovery.destroyed) {
      await joinRoom(slug)
    }
  } catch (err) {
    log('warn', 'joinRoom during openRoomFor failed', { message: err && err.message })
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
    // Bootstrap the peer's Autobases onto the host's shared roots when known.
    // Null on host (fresh autobase) and on the initial peer open before the
    // host's `room:hello` frame arrives; the peer reopens with the correct
    // keys as soon as the frame lands.
    chatBootstrap,
    playheadBootstrap,
    // Wave 15: pass the shared blind-peering client. Handles feature-flag off
    // internally by returning a no-op client (see bare/blindPeering.js).
    blindPeering,
    // Demo automation hooks. Non-fatal if any subsystem is not yet loaded;
    // the timeline degrades to no-op branches when a dep is null (e.g. the
    // announcer is not enabled). See bare/demoTimeline.js head memo.
    demoHooks: {
      get announcer() { return announcer },
      get commentator() { return commentator },
      log: (level, msg, extra) => log(level, msg, extra),
      emit: (event, payload) => emit(event, payload)
    },
    onTipStateChange: (kind, row) => {
      // Tier 4 batch tip: the batch-* kinds carry a shape distinct from the
      // single-tip row (recipients[], userOpHash, etherscanUrl). Route them
      // through a dedicated sanitizer so the batch details survive; single-tip
      // kinds keep the original whitelist.
      if (typeof kind === 'string' && kind.startsWith('batch-')) {
        emit('tip:' + kind, sanitizeTipBatchPayload(row))
        return
      }
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

  // Tier 3: tactical drawing channel event fanout. The channel itself is
  // attached per-connection above in the swarm.on('connection') handler; here
  // we forward each event kind to the renderer so TacticalOverlay can react.
  // Feature-flagged behind CURVA_TACTICAL_ENABLED so production defaults off.
  if (typeof room.onTactical === 'function') {
    for (const kind of ['stroke', 'presence', 'typing', 'freeze', 'unfreeze']) {
      try {
        room.onTactical(kind, (m) => emit('tactical:' + kind, m))
      } catch (err) {
        log('warn', 'tactical subscribe failed', { kind, error: err?.message })
      }
    }
  }

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
    // Feature 2 (identity chip): decode identity_proof -> identityPublicKeyHex.
    // IdentityKey.verify without expectedIdentity still validates the chain and
    // returns the identity public key embedded in the proof. We do NOT require
    // expectedIdentity here because we want to DISPLAY who signed, not assert it
    // matches a pre-known key. Security note: the proof still cryptographically
    // binds the identity public key to the message payload, so a peer cannot
    // forge a different identity on a message they wrote.
    if (typeof msg.identity_proof === 'string' && msg.identity_proof.length >= 130 && IdentityKey) {
      try {
        const proofBuf = Buffer.from(msg.identity_proof, 'hex')
        // Reconstruct the canonical payload: same sorted-key JSON that
        // keetIdentity.js attest() uses (see bare/keetIdentity.js canonicalize).
        // identity_proof is excluded because attest() runs before the field is set.
        const { identity_proof: _proof, ...payloadForVerify } = msg
        // Recursive sorted-key serializer matching keetIdentity.js canonicalize()
        const canonVal = (v) => {
          if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
          if (typeof v === 'number') return v
          if (Array.isArray(v)) return v.map(canonVal)
          if (typeof v === 'object') {
            const obj = {}
            for (const k of Object.keys(v).sort()) {
              if (v[k] !== undefined) obj[k] = canonVal(v[k])
            }
            return obj
          }
          return v
        }
        const canonicalBytes = Buffer.from(JSON.stringify(canonVal(payloadForVerify)), 'utf8')
        const res = IdentityKey.verify(proofBuf, canonicalBytes, {})
        if (res && res.identityPublicKey) {
          enriched.identityPublicKeyHex = Buffer.from(res.identityPublicKey).toString('hex')
          enriched.identity_verified = true
        } else {
          enriched.identity_verified = false
        }
      } catch {
        enriched.identity_verified = false
      }
    } else if (msg.identity_proof !== undefined && msg.identity_proof !== null) {
      // Proof field present but malformed
      enriched.identity_verified = false
    }
    // identity_verified null/undefined = no proof (legacy message)
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

  // Tier 4: Supertonic announcer also reacts to host-broadcast `system:goal`
  // chat rows so peers hear a synthesized announcement even when the goal
  // did not come from the backend SSE feed. Fire-and-forget.
  if (announcerFlagEnabled) {
    const off = room.chat.onMessage((msg) => {
      if (!announcer || !msg || msg.type !== 'system:goal') return
      const targets = announcerLocalesEnv || [announcerDefaultLocale]
      for (const targetLocale of targets) {
        announcer.speak({
          matchId: msg.matchId || msg.match_id || null,
          minute: msg.minute,
          scorer: msg.scorer || '',
          team: msg.team || '',
          score: msg.newScore || msg.score || null,
          targetLocale
        })
          .then((audio) => {
            if (!audio) return
            emit('announcer:audio', audio)
          })
          .catch((err) => {
            log('warn', 'announcer.speak (chat) failed', {
              locale: targetLocale, message: err && err.message
            })
          })
      }
    })
    roomUnsubs.push(off)
  }

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
    // Host side: broadcast our Autobase primary keys so peers can converge
    // onto the same shared root. Without this, `new Autobase(store, null, ...)`
    // on each peer creates orphan autobases whose apply()/view.put() writes
    // never reach anyone else, even though addWriter succeeds (Pattern B
    // operates on the peer's own orphan autobase). See Autobase README §API,
    // "loading an existing Autobase" (https://github.com/holepunchto/autobase).
    if (writerFlagEnabled && room.isHost) {
      try {
        const chatBase = room.chat.getBase?.()
        const phBase = room.playhead.getBase?.()
        const chatKeyHex = chatBase?.key ? b4a.toString(chatBase.key, 'hex') : null
        const phKeyHex = phBase?.key ? b4a.toString(phBase.key, 'hex') : null
        if (chatKeyHex && phKeyHex) {
          // Piggyback host wallet metadata onto room:hello so the peer can
          // populate its tip form without waiting for roomState replication.
          // roomState is a per-peer local Hyperbee and does not currently
          // cross-replicate (Phase 4+ work); the swarm-level hello frame is
          // the reliable channel we already own.
          const w = walletReady ? wallet?.getInfo?.() : null
          writeSocketJson(conn, {
            kind: 'room:hello',
            chatBaseKey: chatKeyHex,
            playheadBaseKey: phKeyHex,
            hostSmartAddress: w?.smartAddress || null,
            hostOwnerAddress: w?.ownerAddress || null,
            hostChainId: w?.chainId || null
          })
        }
      } catch (err) {
        log('warn', 'room:hello send failed', { message: err.message })
      }
    }
    // Peer side: send our invitation as soon as the socket is open. Host
    // ignores its own invitation attempt (handleWriterRequest short-circuits
    // via `not-host`).
    if (writerFlagEnabled && !room.isHost && typeof room.signMyWriterInvitations === 'function') {
      // Also request the host's Autobase base keys. If the peer's local
      // Autobase was opened with null bootstrap (initial boot before host was
      // known), it will reopen with the correct bootstrap once the host
      // replies with `room:hello`. `request-hello` is idempotent — hosts
      // always respond with their current base keys.
      writeSocketJson(conn, { kind: 'request-hello' })
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

      // Host side: peer explicitly asked for our base keys (handles the case
      // where our unsolicited `room:hello` beat the peer's data listener into
      // existence and was consumed by another data listener before the writer
      // handshake attached). Reply with the same shape as the unsolicited path.
      if (frame.kind === 'request-hello' && room?.isHost && writerFlagEnabled) {
        try {
          const chatBase = room.chat.getBase?.()
          const phBase = room.playhead.getBase?.()
          const chatKeyHex = chatBase?.key ? b4a.toString(chatBase.key, 'hex') : null
          const phKeyHex = phBase?.key ? b4a.toString(phBase.key, 'hex') : null
          if (chatKeyHex && phKeyHex) {
            const w = walletReady ? wallet?.getInfo?.() : null
            writeSocketJson(conn, {
              kind: 'room:hello',
              chatBaseKey: chatKeyHex,
              playheadBaseKey: phKeyHex,
              hostSmartAddress: w?.smartAddress || null,
              hostOwnerAddress: w?.ownerAddress || null,
              hostChainId: w?.chainId || null
            })
          }
        } catch (err) {
          log('warn', 'room:hello reply failed', { message: err.message })
        }
        return
      }

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
            // Feature 3 (HUD): update writer count after promotion.
            try {
              const roster = room.getWriterRoster()
              emit('room:writers-update', { writerCount: roster ? roster.size : 0 })
            } catch { /* non-fatal */ }
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
      // Peer side: receive host's Autobase base keys. If our current room's
      // chat/playhead bases have different keys, reopen the room with the
      // correct bootstrap so both peers share the same Autobase root. Guarded
      // by `roomBootstrapReopenInFlight` so a burst of connections (host may
      // reconnect during churn) does not stack reopens.
      if (frame.kind === 'room:hello' && room && !room.isHost) {
        try {
          // Cross-peer tip fix: consume the host's wallet metadata piggybacked
          // on the hello frame. This bypasses the un-replicated roomState
          // Hyperbee and unblocks the tip form immediately once we have a
          // direct swarm connection to the host.
          if (typeof frame.hostSmartAddress === 'string' && frame.hostSmartAddress.startsWith('0x')) {
            const smart = frame.hostSmartAddress.toLowerCase()
            const owner = typeof frame.hostOwnerAddress === 'string' ? frame.hostOwnerAddress.toLowerCase() : null
            const isFirst = !cachedHostAddresses
            const changed = !cachedHostAddresses || cachedHostAddresses.smartAddress !== smart
            if (changed) {
              cachedHostAddresses = { smartAddress: smart, ownerAddress: owner }
              emit('tip:host-discovered', {
                chainId: frame.hostChainId || null,
                smartAddress: smart,
                ownerAddress: owner
              })
              log('info', 'tip:host-discovered via hello frame', { smart })
              // If the room was originally opened without a host address, the
              // tip service is null (see bare/room.js:180 — needs both wallet
              // and hostSmartAddr at open time). Reopen the room now that we
              // know the host address so room.tip gets constructed.
              if (isFirst && walletReady && room && !room.isHost && !room.tip) {
                const slug = room.slug
                setTimeout(() => {
                  openRoomFor(slug, false).catch((err) =>
                    log('warn', 'reopen after host discovery failed', { message: err.message })
                  )
                }, 500)
              }
              // Demo auto-tip: if CURVA_DEMO_AUTO_TIP=true, fire a real
              // proposeTip 3s after host discovery so the E2E path lands
              // an Etherscan-visible tx without requiring a UI click. Guarded
              // so it only fires once per boot on the peer (not host).
              if (process.env.CURVA_DEMO_AUTO_TIP === 'true' && !demoAutoTipFired) {
                // Poll every 3s (up to 20 times = 60s) until room.tip is
                // ready AND wallet is ready, then submit exactly one tip.
                let attempts = 0
                const poll = setInterval(async () => {
                  attempts++
                  if (demoAutoTipFired || attempts > 20) { clearInterval(poll); return }
                  if (!walletReady || !room?.tip || typeof room.tip.proposeTip !== 'function') {
                    log('info', 'auto-tip waiting', { attempts, walletReady, hasTip: !!room?.tip })
                    return
                  }
                  demoAutoTipFired = true
                  clearInterval(poll)
                  try {
                    log('info', 'auto-tip firing', { to: smart, attempts })
                    const row = await room.tip.proposeTip({ amount: '1000000', note: 'e2e-cross-peer' })
                    log('info', 'auto-tip result', { status: row?.status, tx_hash: row?.tx_hash, error: row?.error })
                  } catch (err) {
                    log('error', 'auto-tip failed', { message: err?.message, code: err?.code })
                    demoAutoTipFired = false // allow one retry on transient error
                  }
                }, 3000)
              }
            }
          }
          const chatBase = room.chat.getBase?.()
          const phBase = room.playhead.getBase?.()
          const curChat = chatBase?.key ? b4a.toString(chatBase.key, 'hex') : null
          const curPh = phBase?.key ? b4a.toString(phBase.key, 'hex') : null
          const targetChat = typeof frame.chatBaseKey === 'string' ? frame.chatBaseKey.toLowerCase() : null
          const targetPh = typeof frame.playheadBaseKey === 'string' ? frame.playheadBaseKey.toLowerCase() : null
          if (targetChat && targetPh && (curChat !== targetChat || curPh !== targetPh)) {
            if (!roomBootstrapReopenInFlight) {
              roomBootstrapReopenInFlight = (async () => {
                const slug = room.slug
                log('info', 'reopening room with host bootstrap', {
                  chat: targetChat.slice(0, 8),
                  playhead: targetPh.slice(0, 8)
                })
                await openRoomFor(slug, false, {
                  chatBootstrap: targetChat,
                  playheadBootstrap: targetPh
                })
                // After reopen, the peer's Autobase writer core keys have
                // rotated (new namespaced corestore inside the reopened room).
                // Re-send the writer invitation over every existing connection
                // so the host promotes our NEW writer keys, not the stale
                // pre-reopen ones. Idempotent on host — handleWriterRequest
                // short-circuits if the pair is already in the roster.
                if (room && !room.isHost && typeof room.signMyWriterInvitations === 'function') {
                  try {
                    const payload = await room.signMyWriterInvitations()
                    for (const c of swarm.connections) {
                      writeSocketJson(c, { kind: 'request-writer', payload })
                    }
                    log('info', 'resent request-writer after reopen')
                  } catch (err) {
                    log('warn', 'resent request-writer failed', { message: err.message })
                  }
                }
              })()
                .catch((err) => log('warn', 'room bootstrap reopen failed', { message: err.message }))
                .finally(() => { roomBootstrapReopenInFlight = null })
            }
          }
        } catch (err) {
          log('warn', 'room:hello handling failed', { message: err.message })
        }
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
  // Hyperbee. Best-effort — replication may not have completed yet, so we
  // poll on an interval until we successfully get the host address. Bounded
  // at 60s (20 attempts x 3s) so a truly disconnected host doesn't spam the
  // log forever. Emits `tip:host-discovered` on success (see
  // tryDiscoverHostAddress) which the renderer consumes to unblock the tip
  // button.
  if (!isHost && room.roomState) {
    let attempts = 0
    const maxAttempts = 20
    const discoverPoll = setInterval(async () => {
      attempts++
      if (attempts > maxAttempts || cachedHostAddresses?.smartAddress) {
        clearInterval(discoverPoll)
        return
      }
      // Guard against race where room was closed between ticks — `room` and
      // `room.roomState` may have been nulled by closeCurrentRoom(). Without
      // this the setInterval callback dereferences a closed Hyperbee and
      // crashes the Bare worker (exit code 1).
      if (!room || !room.roomState) {
        clearInterval(discoverPoll)
        return
      }
      try {
        await tryDiscoverHostAddress()
      } catch (err) {
        log('warn', 'host tip-address discovery failed', { message: err.message, attempt: attempts })
      }
    }, 3000)
    // Ensure the poller is cleared on room close so it doesn't reference a
    // torn-down roomState after teardown (would surface as Bare worker crash).
    roomUnsubs.push(() => clearInterval(discoverPoll))
    // Fire once immediately (don't wait 3s for first attempt)
    tryDiscoverHostAddress().catch((err) =>
      log('warn', 'host tip-address discovery failed', { message: err.message })
    )
  }

  // Feature 1 (WC reel on Hyperdrive): publish the local sample-clip.mp4 into
  // this peer's own drive at /wc-reel/reel.mp4, then get a loopback blob-server
  // URL and emit `wc-reel:link`. Non-host peers also publish so they each have
  // their own stream URL (the drive is per-peer-owned, replicated read-only by
  // the rest). Falls back to the local file if anything fails.
  // Capture `room.clips` reference at schedule time so the 500ms-deferred
  // callback isn't affected by a concurrent room close/reopen.
  const _wcReelClips = room.clips
  setTimeout(() => {
    ;(async () => {
      try {
        if (!bareFs || !barePath || !_wcReelClips || typeof _wcReelClips.publishReel !== 'function') return
        // Resolve the assets dir. Try multiple candidate paths in priority order:
        // 1. Relative to Bare.argv[3] (app path, non-null in packaged builds).
        // 2. Relative to the worker file itself via require.main?.filename.
        // 3. 'assets/<file>' relative to cwd (dev mode: project root).
        const sampleClip = 'sample-clip.mp4'
        const candidates = []
        const appFilename = config.app || (typeof Bare !== 'undefined' && Bare.argv && Bare.argv[3]) || null
        if (appFilename) candidates.push(barePath.join(appFilename, '..', 'assets', sampleClip))
        const workerFile = (typeof require !== 'undefined' && require.main && require.main.filename) || null
        if (workerFile) candidates.push(barePath.join(barePath.dirname(workerFile), '..', 'assets', sampleClip))
        candidates.push(barePath.join('assets', sampleClip))
        candidates.push(barePath.join('.', 'assets', sampleClip))

        let buf = null
        for (const candidate of candidates) {
          try { buf = await bareFs.promises.readFile(candidate); if (buf && buf.length > 0) break } catch { buf = null }
        }
        if (!buf || buf.length === 0) return
        const drivePath = await _wcReelClips.publishReel(buf, 'reel.mp4')
        const linkObj = _wcReelClips.getReelLink(_wcReelClips.myDriveKey, drivePath)
        emit('wc-reel:link', { url: linkObj.url, driveKey: _wcReelClips.myDriveKey, drivePath })
        log('info', 'wc-reel:link emitted', { url: linkObj.url.slice(0, 60), drivePath })
      } catch (err) {
        log('warn', 'wc-reel publish failed (fallback to local file)', { message: err?.message })
      }
    })()
  }, 500)

  // Force every Autobase writer core to become replicable. Autobase opens
  // its writer cores with `active: false` (autobase/index.js:_makeWriterCore),
  // and `_shouldReplicate` in corestore/index.js:475 gates on
  // `core.replicator.downloading && core.opened && this.active`. An
  // active:false-only core has `replicator.downloading === false`, so
  // `store.replicate(conn)` from the module-level `swarm.on('connection')`
  // never attaches it to the muxer. The remote side likewise never
  // discovers our writer core's discovery key, so replication deadlocks
  // and chat blocks stay stuck on the local corestore forever.
  //
  // Opening an active:true session on the same core key promotes the
  // aggregate `replicator.downloading` to true. Any subsequent replicate()
  // call (including the one on the module-level connection handler) will
  // now attach the writer core to the muxer, and Autobase's wakeup
  // protocol pushes new blocks through it.
  //
  // Additionally call `base.replicate(conn)` for every existing muxer to
  // wake the wakeup channel on those streams so the newly-active writer
  // gets its addWriter block replicated immediately, without waiting for
  // the next connection.
  try {
    const chatBase = room.chat?.getBase?.()
    const phBase = room.playhead?.getBase?.()
    // Close any active sessions from a prior openRoomFor call (the reopens
    // that fire on wallet:ready and after room:hello). Sessions hold the
    // core open and pin the active count above zero; leaking them across
    // reopens keeps stale writer keys downloadable and can crash on close.
    while (localWriterActiveSessions.length > 0) {
      const s = localWriterActiveSessions.pop()
      try { await s.close() } catch { /* best-effort */ }
    }
    if (chatBase?.local && typeof chatBase.local.session === 'function') {
      try {
        const s = chatBase.local.session({ active: true })
        await s.ready?.()
        localWriterActiveSessions.push(s)
      } catch (err) {
        log('warn', 'chat local active session failed', { message: err && err.message })
      }
    }
    if (phBase?.local && typeof phBase.local.session === 'function') {
      try {
        const s = phBase.local.session({ active: true })
        await s.ready?.()
        localWriterActiveSessions.push(s)
      } catch (err) {
        log('warn', 'playhead local active session failed', { message: err && err.message })
      }
    }
    if (swarm && (chatBase || phBase)) {
      for (const conn of swarm.connections) {
        try { if (chatBase?.replicate) chatBase.replicate(conn) } catch (err) {
          log('warn', 'chatBase.replicate failed', { message: err && err.message })
        }
        try { if (phBase?.replicate) phBase.replicate(conn) } catch (err) {
          log('warn', 'phBase.replicate failed', { message: err && err.message })
        }
      }
      log('info', 'autobase writer cores attached to muxers', {
        conns: swarm.connections.size ?? 0,
        chatWriterKey: chatBase?.local?.key ? chatBase.local.key.toString('hex').slice(0, 8) : null
      })
    }
  } catch (err) {
    log('warn', 'autobase replicate wiring failed', { message: err && err.message })
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

  // Diagnostic autochat for cross-peer sync verification. When
  // CURVA_AUTOCHAT_TEST=<text> is set, appends that text via room.chat.send
  // 20 seconds after room ready. Both peers log every incoming chat message
  // (whether local or remote) via the existing `chat:msg` emit path AND via
  // this diag hook so a grep on the peer's log confirms replication.
  const autochatText = (typeof process !== 'undefined' && process.env && process.env.CURVA_AUTOCHAT_TEST) || ''
  if (autochatText && typeof room.chat.send === 'function') {
    setTimeout(() => {
      room.chat.send({ text: String(autochatText).slice(0, 200), match_time_ms: 0 })
        .then((msg) => log('info', 'AUTOCHAT sent', { text: msg.text }))
        .catch((err) => log('warn', 'AUTOCHAT send failed', { message: err?.message }))
    }, 20_000)
  }
  if (typeof room.chat.onMessage === 'function') {
    room.chat.onMessage((msg) => {
      if (msg?.type === 'msg') {
        log('info', 'AUTOCHAT observed', {
          text: msg.text,
          by: (msg.by_peer || '').slice(0, 8),
          local: msg.by_peer === identity.pubkey
        })
      }
    })
  }

  // Feature 3 (HUD): emit initial autobase writer count so the HUD has a
  // value before any addWriter events. `getWriterRoster()` returns a Set of
  // unique hex writer keys; each peer contributes 2 (chat + playhead), so
  // writerCount = roster.size reflects total registered writer slots.
  try {
    const roster = room.getWriterRoster()
    emit('room:writers-update', { writerCount: roster ? roster.size : 0 })
  } catch { /* non-fatal */ }

  // Wave 13B: kick roomBot when the flag is on. Fire-and-forget so a slow
  // model load never blocks room:ready. If the commentator flag is also on
  // the renderer will call `commentator:enable` on the host; only after that
  // load will getSharedLlmHandle() return non-null and a subsequent
  // ensureRoomBot() would reuse it. For simplicity roomBot here loads its own
  // Qwen3 handle if no shared one is available yet.
  if (botFlagEnabled) {
    ensureRoomBot().catch((err) => {
      log('warn', 'ensureRoomBot failed', { message: err && err.message })
    })
  }
}

async function tryDiscoverHostAddress() {
  if (!room || !room.roomState) return
  const node = await room.roomState.get('room/host-tip-address').catch((err) => {
    log('warn', 'roomState.get host-tip-address threw', { message: err?.message })
    return null
  })
  log('info', 'tryDiscoverHostAddress read', { found: !!node?.value?.smartAddress, node: node?.value ? { smart: node.value.smartAddress } : null })
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
    log('info', 'tip:host-discovered emitted', { smart: node.value.smartAddress })
    return
  }
  // Fallback: swarm-based delivery (room:hello piggyback + roomState Hyperbee)
  // fails when two peers on the same laptop cannot hole-punch each other, or
  // when replication has not caught up yet. The backend directory already
  // stores hostSmartAddress + hostOwnerAddress at room-registration time
  // (POST /rooms), so read that as a public fallback. This is safe because
  // the directory record is host-signed and any tip the peer sends still
  // requires the sponsor to accept the EIP-3009 authorization. Best-effort.
  try {
    if (!room || room.isHost) return
    if (!config.backendUrl || !room.slug) return
    const url = config.backendUrl.replace(/\/$/, '') + '/rooms/' + encodeURIComponent(room.slug)
    const res = await fetch(url).catch(() => null)
    if (!res || !res.ok) return
    const body = await res.json().catch(() => null)
    const rec = body?.data?.room
    const smart = typeof rec?.hostSmartAddress === 'string' && rec.hostSmartAddress.startsWith('0x')
      ? rec.hostSmartAddress.toLowerCase()
      : null
    const owner = typeof rec?.hostOwnerAddress === 'string' && rec.hostOwnerAddress.startsWith('0x')
      ? rec.hostOwnerAddress.toLowerCase()
      : null
    if (!smart) return
    const isFirst = !cachedHostAddresses
    cachedHostAddresses = { smartAddress: smart, ownerAddress: owner }
    emit('tip:host-discovered', {
      chainId: rec?.chainId || null,
      smartAddress: smart,
      ownerAddress: owner
    })
    log('info', 'tip:host-discovered via backend directory', { smart, owner })
    // Same-laptop demo helper: the directory also carries the host's Autobase
    // base keys when the host has published them (see PUT /rooms/:slug/bases).
    // Re-open the room with the correct bootstrap so the viewer's chat and
    // playhead Autobases point at the host's cores. Once the seeder subprocess
    // replicates the cores in both directions, chat sync works without a
    // direct swarm socket between the two peers.
    const targetChat = typeof rec?.chatBaseKey === 'string' && /^[0-9a-f]{64}$/.test(rec.chatBaseKey)
      ? rec.chatBaseKey.toLowerCase()
      : null
    const targetPh = typeof rec?.playheadBaseKey === 'string' && /^[0-9a-f]{64}$/.test(rec.playheadBaseKey)
      ? rec.playheadBaseKey.toLowerCase()
      : null
    if (targetChat && targetPh && room && !room.isHost && !roomBootstrapReopenInFlight) {
      const chatBase = room.chat.getBase?.()
      const phBase = room.playhead.getBase?.()
      const curChat = chatBase?.key ? b4a.toString(chatBase.key, 'hex') : null
      const curPh = phBase?.key ? b4a.toString(phBase.key, 'hex') : null
      if (curChat !== targetChat || curPh !== targetPh) {
        roomBootstrapReopenInFlight = (async () => {
          const slug = room.slug
          log('info', 'reopening room with host bootstrap via backend directory', {
            chat: targetChat.slice(0, 8),
            playhead: targetPh.slice(0, 8)
          })
          await openRoomFor(slug, false, {
            chatBootstrap: targetChat,
            playheadBootstrap: targetPh
          })
        })()
          .catch((err) => log('warn', 'directory-driven bootstrap reopen failed', { message: err.message }))
          .finally(() => { roomBootstrapReopenInFlight = null })
        return
      }
    }
    if (isFirst && walletReady && room && !room.isHost && !room.tip) {
      const slug = room.slug
      setTimeout(() => {
        openRoomFor(slug, false).catch((err) =>
          log('warn', 'reopen after directory discovery failed', { message: err.message })
        )
      }, 500)
    }
  } catch (err) {
    log('warn', 'backend directory fallback failed', { message: err?.message })
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

// Tier 4: batch tip payloads have a different shape (recipients[] instead of
// a single to_address, userOpHash instead of tx hash). Whitelist the display
// fields the renderer needs and drop anything wallet-internal.
function sanitizeTipBatchPayload(payload) {
  if (!payload || typeof payload !== 'object') return null
  return {
    status: payload.status || null,
    userOpHash: payload.userOpHash || payload.user_op_hash || payload.tx_hash || null,
    count: payload.count ?? (Array.isArray(payload.recipients) ? payload.recipients.length : null),
    totalAtomic: payload.totalAtomic || payload.total_base || null,
    etherscanUrl: payload.etherscanUrl || null,
    recipients: Array.isArray(payload.recipients)
      ? payload.recipients.map((r) => ({
          address: r.address || null,
          handle: r.handle || null,
          amountAtomicUsdt: r.amountAtomicUsdt || null
        }))
      : null,
    fee: payload.fee || payload.userop_fee || null,
    token: payload.token || null,
    chainId: payload.chainId || null,
    route: payload.route || 'erc4337-batch',
    created_at: payload.created_at || null,
    submitted_at: payload.submitted_at || null,
    error: payload.error || null
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
    // Bare-runtime compatibility: WDK + ethers require Node built-ins like
    // 'http', 'https', 'zlib', 'stream', etc. Bare has no such built-ins,
    // but `bare-node-runtime/imports` ships a JSON alias map that Bare's
    // module resolver honours via the `with: { imports }` option. Passing
    // it here tells Bare "when this module tree tries to require('http'),
    // resolve it to 'bare-http1' instead". Applies transitively to all
    // sub-requires under this load.
    const withBareImports = { with: { imports: 'bare-node-runtime/imports' } }
    WDK = require('@tetherto/wdk', withBareImports)
    WalletFactory = require('@tetherto/wdk-wallet-evm-erc-4337', withBareImports)
    SecretManager = require('@tetherto/wdk-secret-manager', withBareImports)
    ethers = require('ethers', withBareImports)
    // Some packages export default vs. named — normalize. wdk-secret-manager
    // exports `{ wdkSaltGenerator, WdkSecretManager }`, so we unwrap the class
    // rather than passing the plain object (which would fail as a constructor
    // in bare/wallet/worklet.js `new SecretManager(...)`).
    WDK = WDK.default || WDK
    WalletFactory = WalletFactory.default || WalletFactory
    SecretManager = SecretManager.default || SecretManager.WdkSecretManager || SecretManager
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

  const info = await wallet.init({ passcode, storageDir, backendBaseUrl: config.backendUrl })
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

  // Tier 4 Round 2: bootstrap keet portable identity behind the feature flag.
  // Uses the same passcode as the WDK wallet (spec requirement) but a SEPARATE
  // storage sub-dir so a wallet-reset does not accidentally corrupt the identity
  // blob. Any error here is non-fatal for the wallet path; the room simply
  // renders messages as unverified.
  keetIdentityPasscode = passcode
  try {
    await ensureKeetIdentityLoaded()
  } catch (err) {
    log('warn', 'keet identity boot failed', { message: err?.message, code: err?.code })
  }

  // If we have an open room, re-open it so the tip service gets wired with the
  // newly-initialized wallet. This is cheaper than a full swarm rejoin.
  if (room) {
    const slug = room.slug
    const wasHost = room.isHost
    await closeCurrentRoom()
    await openRoomFor(slug, wasHost)
    // Cross-peer tip fix: if we became the host, re-broadcast our hello frame
    // to every existing swarm connection so already-connected peers learn our
    // wallet metadata without waiting for a fresh connection.
    if (wasHost && room && walletReady) {
      try {
        const chatBase = room.chat.getBase?.()
        const phBase = room.playhead.getBase?.()
        const chatKeyHex = chatBase?.key ? b4a.toString(chatBase.key, 'hex') : null
        const phKeyHex = phBase?.key ? b4a.toString(phBase.key, 'hex') : null
        const w = wallet?.getInfo?.()
        if (chatKeyHex && phKeyHex && w?.smartAddress && swarm) {
          for (const c of swarm.connections) {
            writeSocketJson(c, {
              kind: 'room:hello',
              chatBaseKey: chatKeyHex,
              playheadBaseKey: phKeyHex,
              hostSmartAddress: w.smartAddress,
              hostOwnerAddress: w.ownerAddress,
              hostChainId: w.chainId
            })
          }
          log('info', 'rebroadcast room:hello with wallet after wallet:ready', {
            connCount: swarm.connections.size ?? '?'
          })
        }
        // Same-laptop demo helper: also publish the base keys to the backend
        // directory so viewers who never form a direct swarm socket to the
        // host can still bootstrap the correct Autobase. Non-authoritative,
        // best-effort; the P2P `room:hello` path stays the primary and the
        // authoritative source of truth. Retries with backoff because
        // wallet:ready often fires before the host has clicked "Publish to
        // directory", so the DB row does not yet exist and PUT returns 404.
        if (chatKeyHex && phKeyHex && config.backendUrl && room.slug) {
          const url = config.backendUrl.replace(/\/$/, '') + '/rooms/' + encodeURIComponent(room.slug) + '/bases'
          const body = JSON.stringify({ chatBaseKey: chatKeyHex, playheadBaseKey: phKeyHex })
          ;(async () => {
            const maxAttempts = 20
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              try {
                const res = await fetch(url, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json', Connection: 'close' },
                  body
                })
                if (res && res.ok) {
                  log('info', 'published base keys to backend directory', {
                    chat: chatKeyHex.slice(0, 8),
                    playhead: phKeyHex.slice(0, 8),
                    attempts: attempt
                  })
                  return
                }
                if (res && res.status === 404) {
                  await new Promise((r) => setTimeout(r, 3000))
                  continue
                }
                log('warn', 'publish base keys failed', { status: res?.status, attempt })
                return
              } catch (err) {
                log('warn', 'publish base keys errored', { message: err?.message, attempt })
                await new Promise((r) => setTimeout(r, 3000))
              }
            }
            log('warn', 'publish base keys gave up after retries', { attempts: maxAttempts })
          })()
        }
      } catch (err) {
        log('warn', 'rebroadcast hello failed', { message: err.message })
      }
    }
  }
}

// -- Tier 4 Round 2 keet identity helpers ---------------------------------
// The identity storage lives in a subdir separate from the wallet blob so a
// wallet-reset cannot corrupt the identity. Same passcode unlocks both.
function keetIdentityStorageDir() {
  const dir = path.join(config.dir, 'curva', 'keet-identity')
  try { fs.mkdirSync(dir, { recursive: true }) } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  return dir
}

async function ensureKeetIdentityLoaded() {
  if (!keetIdentityFeatureEnabled()) return null
  if (keetIdentity) return keetIdentity
  if (!keetIdentityPasscode) return null

  // Lazy-load SecretManager the same way initWallet does.
  let SecretManager
  try {
    require('../bare/wallet/semverPatch.js').applyPatch()
    SecretManager = require('@tetherto/wdk-secret-manager', { with: { imports: 'bare-node-runtime/imports' } })
    SecretManager = SecretManager.default || SecretManager.WdkSecretManager || SecretManager
  } catch (err) {
    log('warn', 'keet identity: SecretManager unavailable', { message: err?.message })
    return null
  }

  const handle = createKeetIdentity({
    SecretManager,
    storageDir: keetIdentityStorageDir(),
    log: (level, msg, meta) => log(level, '[keet] ' + msg, meta)
  })
  const res = await handle.loadOrGenerate({ passphrase: keetIdentityPasscode })
  keetIdentity = handle
  setKeetIdentity(handle)
  emit('identity:ready', {
    identityPublicKey: res.identityPublicKeyHex,
    mnemonicGenerated: !!res.mnemonic
  })
  return handle
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
  if (translator) {
    log('info', 'translator already loaded (reuse)', { targetLang })
    return translator
  }
  if (translatorInitPromise) {
    log('info', 'translator init already in flight', { targetLang })
    return translatorInitPromise
  }

  // Use the backend URL from the currently open room, or fall back to
  // constructing a fresh client. F12 doesn't need a room.
  const backendClient = room?.backend || createBackendClient(config.backendUrl, { lang: 'en' })
  const storageDir = config.dir
  log('info', 'translator init begin', {
    targetLang,
    storageDir,
    backendUrl: backendClient?.baseUrl || null
  })

  translatorInitPromise = createTranslator({
    storageDir,
    backendClient,
    timeoutMs: 30_000,
    onProgress: (ev) => {
      log('info', 'translator progress', ev)
      emit('translate:progress', ev)
    },
    onError: (err) => {
      log('warn', 'translator progress error', { message: err?.message, code: err?.code })
      emit('translate:error', err)
    }
  })
    .then((inst) => {
      translator = inst
      const st = inst.status()
      if (st.ready) {
        translationEnabled = true
        log('info', 'translator ready', { loaded: st.loaded, targetLang })
        emit('translate:ready', { loaded: st.loaded, targetLang })
      } else {
        translationEnabled = false
        log('warn', 'translator loaded but not ready', {
          disabledReason: st.disabledReason,
          loaded: st.loaded
        })
        emit('translate:disabled', { reason: st.disabledReason || 'no models loaded' })
      }
      return inst
    })
    .catch((err) => {
      translationEnabled = false
      emit('translate:disabled', { reason: err?.message || 'init failed' })
      log('warn', 'translator init failed', { message: err?.message, code: err?.code, stack: err?.stack?.slice(0, 400) })
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

// -- F3 (partial): match live SSE consumer --------------------------------
//
// Separate consumer from the activity feed above. Opens a persistent SSE
// connection to `${BACKEND_URL}/match/live/stream` and reacts to two event
// types:
//   - `match.goal`  { matchId, team, newScore:{home,away}, scorer, minute }
//   - `match.score` { matchId, home, away }  (also accepts match.score_changed
//                                             with { current:{home,away} })
// Heartbeats arrive as `match.pulse` every 15s and are ignored.
//
// Forwards to Electron main via emit('badge:score-update', {home,away}) and
// emit('badge:goal-flash', {}). Also invokes in-process subscribers registered
// via matchLiveStreamConsumer.on(eventName, cb) so commentator.js and any
// other worker-side module can react without a second SSE connection.
//
// Reconnect strategy: exponential backoff 500ms, 1s, 2s, 4s, capped at 8s.
// After MAX_CONSECUTIVE_FAILURES (5) consecutive failures OR if backend is
// unset, the consumer disables itself silently with a single warning log.
//
// Docs verified 2026-07-06:
//   https://undici.nodejs.org/#/docs/api/Fetch  (response.body is a web
//   ReadableStream; .getReader() is the stable web-streams API for chunked
//   consumption). Bare ships undici; the same pattern is already used by
//   connectActivityFeed() above.
//   https://html.spec.whatwg.org/multipage/server-sent-events.html  (SSE
//   frame grammar: events separated by blank line; per-event lines prefixed
//   by `event:`, `data:`, `id:`, `retry:`).
const matchLiveStreamConsumer = (() => {
  const MAX_BACKOFF_MS = 8000
  const BACKOFF_SCHEDULE_MS = [500, 1000, 2000, 4000, 8000]
  const MAX_CONSECUTIVE_FAILURES = 5

  let reader = null
  let abortCtrl = null
  let reconnectTimer = null
  let running = false
  let disabled = false
  let consecutiveFailures = 0
  const listeners = new Map() // eventName -> Set<cb>

  function on(eventName, cb) {
    if (typeof eventName !== 'string' || typeof cb !== 'function') return () => {}
    let set = listeners.get(eventName)
    if (!set) {
      set = new Set()
      listeners.set(eventName, set)
    }
    set.add(cb)
    return () => {
      const s = listeners.get(eventName)
      if (s) s.delete(cb)
    }
  }

  function fanout(eventName, payload) {
    const set = listeners.get(eventName)
    if (!set || set.size === 0) return
    for (const cb of set) {
      try { cb(payload) } catch (err) {
        log('warn', 'matchLiveStream listener threw', {
          event: eventName,
          message: err && err.message
        })
      }
    }
  }

  function backoffMs() {
    const idx = Math.min(consecutiveFailures, BACKOFF_SCHEDULE_MS.length - 1)
    return Math.min(MAX_BACKOFF_MS, BACKOFF_SCHEDULE_MS[idx] || MAX_BACKOFF_MS)
  }

  function parseFrame(frame) {
    // SSE frame: lines separated by \n. Fields: event, data, id, retry.
    // Comments (`:` prefix) are ignored. Multi-line data is joined by \n
    // per the spec.
    let evName = 'message'
    const dataLines = []
    let eventId = null
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.replace(/\r$/, '')
      if (line.length === 0) continue
      if (line.startsWith(':')) continue // comment / heartbeat
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') evName = value
      else if (field === 'data') dataLines.push(value)
      else if (field === 'id') eventId = value
    }
    if (dataLines.length === 0) return null
    return { event: evName, id: eventId, data: dataLines.join('\n') }
  }

  function normalizeScore(payload) {
    if (!payload || typeof payload !== 'object') return null
    // match.goal shape: { newScore: {home, away} }
    if (payload.newScore && typeof payload.newScore === 'object') {
      const home = payload.newScore.home | 0
      const away = payload.newScore.away | 0
      return { home: Math.max(0, home), away: Math.max(0, away) }
    }
    // match.score_changed shape: { current: {home, away} }
    if (payload.current && typeof payload.current === 'object') {
      const home = payload.current.home | 0
      const away = payload.current.away | 0
      return { home: Math.max(0, home), away: Math.max(0, away) }
    }
    // match.score flat shape: { home, away }
    if (typeof payload.home === 'number' && typeof payload.away === 'number') {
      return { home: Math.max(0, payload.home | 0), away: Math.max(0, payload.away | 0) }
    }
    return null
  }

  function handleEvent(evName, payload) {
    if (evName === 'match.pulse') {
      // Cup Final: enriched pulse now carries { matchId, minute, status,
      // injuryTime, ts }. When `minute` is present we forward it to the
      // renderer via a dedicated IPC event so the VideoPlayer floating badge
      // can render "34'", "45+3'", "HT", "FT", etc. Empty heartbeats (payload
      // { ts } only) fall through and are ignored the same as before.
      if (payload && typeof payload === 'object' && typeof payload.matchId === 'string') {
        const matchId = payload.matchId
        const minute = Number.isFinite(payload.minute) ? (payload.minute | 0) : null
        const status = typeof payload.status === 'string' ? payload.status : null
        const injuryTime = Number.isFinite(payload.injuryTime) ? (payload.injuryTime | 0) : null
        const out = { matchId, minute, status, injuryTime, ts: Date.now() }
        emit('match:minute-update', out)
        fanout('match.minute', out)
      }
      return
    }
    if (evName === 'match.goal') {
      const score = normalizeScore(payload)
      if (score) {
        emit('badge:score-update', score)
      }
      emit('badge:goal-flash', {})
      fanout('match.goal', payload)
      return
    }
    if (evName === 'match.score' || evName === 'match.score_changed') {
      const score = normalizeScore(payload)
      if (score) {
        emit('badge:score-update', score)
        fanout('match.score', { ...payload, ...score })
      }
      return
    }
    // Any other event type is fanned out but not badged.
    fanout(evName, payload)
  }

  async function readLoop(resp) {
    reader = resp.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const parsed = parseFrame(frame)
        if (!parsed) continue
        let payload
        try { payload = JSON.parse(parsed.data) } catch { continue }
        handleEvent(parsed.event, payload)
      }
    }
  }

  async function openOnce() {
    const backend = config.backendUrl
    if (!backend || typeof backend !== 'string') {
      throw new Error('backend URL unset')
    }
    // Backend registers matchLiveStreamRoutes under the '/matches' prefix
    // (see backend/index.ts line 203). The SSE endpoint inside that plugin is
    // '/live/stream', so the full URL is '/matches/live/stream'. The singular
    // '/match/live/stream' variant returns 404.
    const url = backend.replace(/\/$/, '') + '/matches/live/stream'
    // Bare runtime (used by Pear workers) does not always expose AbortController
    // as a global. Guard the reference so we degrade gracefully: without a
    // signal we lose the ability to abort in-flight fetches on shutdown, but
    // the reconnect loop and reader.cancel() path still handle disconnection.
    const AC = (typeof AbortController !== 'undefined') ? AbortController : null
    abortCtrl = AC ? new AC() : null
    const fetchInit = { headers: { Accept: 'text/event-stream' } }
    if (abortCtrl) fetchInit.signal = abortCtrl.signal
    const resp = await fetch(url, fetchInit)
    if (!resp.ok || !resp.body) {
      throw new Error('http ' + resp.status)
    }
    log('info', 'match live SSE consumer connected', { url })
    consecutiveFailures = 0
    await readLoop(resp)
  }

  async function runLoop() {
    while (running && !disabled) {
      try {
        await openOnce()
        // Clean EOF: treat as a transient disconnect. Reconnect after the
        // shortest backoff step. Do NOT count as a failure since the server
        // may have simply completed a request lifecycle.
        log('info', 'match live SSE stream closed by server; will reconnect')
      } catch (err) {
        if (!running) break
        consecutiveFailures++
        log('warn', 'match live SSE consumer failed', {
          message: err && err.message,
          attempt: consecutiveFailures
        })
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          disabled = true
          log('warn', 'match live SSE consumer disabled after repeated failures', {
            failures: consecutiveFailures
          })
          break
        }
      } finally {
        try { if (reader) reader.cancel() } catch { /* noop */ }
        reader = null
        abortCtrl = null
      }
      if (!running || disabled) break
      const wait = backoffMs()
      await new Promise((resolve) => {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          resolve()
        }, wait)
      })
    }
    running = false
  }

  function start() {
    if (running || disabled) return
    if (!config.backendUrl) {
      log('warn', 'match live SSE consumer skipped: backend URL unset')
      disabled = true
      return
    }
    running = true
    consecutiveFailures = 0
    runLoop().catch((err) => {
      log('error', 'match live SSE consumer loop crashed', {
        message: err && err.message
      })
      running = false
    })
  }

  function stop() {
    running = false
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (abortCtrl) {
      try { abortCtrl.abort() } catch { /* noop */ }
    }
    if (reader) {
      try { reader.cancel() } catch { /* noop */ }
    }
    reader = null
    abortCtrl = null
  }

  return { start, stop, on }
})()

async function closeCurrentRoom() {
  if (!room) return
  const slug = room.slug
  for (const off of roomUnsubs) {
    try { off() } catch { /* noop */ }
  }
  roomUnsubs = []
  disconnectActivityFeed()
  // Wave 13B: unhook the roomBot chat subscription before the room's autobase
  // goes away so we don't hold a dangling callback reference. The bot itself
  // keeps its LLM handle for the next room-open (avoiding a re-download).
  if (roomBotChatUnsub) {
    try { roomBotChatUnsub() } catch { /* noop */ }
    roomBotChatUnsub = null
  }
  // If the room is closing we drop the bot entirely so a rejoin uses the
  // freshly-opened room.chat. The Qwen3 handle it owns is unloaded here iff
  // it was not shared with the commentator.
  if (roomBot) {
    try { await roomBot.close() } catch { /* noop */ }
    roomBot = null
  }
  // F1: clear the dock badge whenever a room closes so the icon doesn't hold
  // a stale score after the user leaves the match.
  emit('badge:clear', {})
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

    // pear.assets branding pack: emit initial branding snapshot. Path is null
    // until the drive lands (async background fetch per Pear docs). The
    // renderer must render a bundled fallback first, then re-render on the
    // 'assets:branding' event when path becomes a string. See
    // branding-drive/PUBLISH.md for the publish/link-versioning workflow.
    emitBrandingSnapshot()

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
        // Explicit relay peer join. `relayThrough` only names the pubkey; it
        // does not make hyperswarm establish or maintain the actual TCP/UDX
        // socket to that peer. Without an active connection to the relay,
        // relayed hole-punches have no upstream to hop through and the peer
        // silently degrades to direct-only. `swarm.joinPeer(publicKey)` opens
        // a persistent client-only connection that hyperswarm will re-use for
        // every relayed connection request.
        //
        // Only join when we actually plan to route through the relay
        // (forceRelayEnv=true) so peers on healthy networks don't pin an
        // unnecessary socket to the backend on every boot.
        if (relayKeyBuf && forceRelayEnv) {
          try {
            swarm.joinPeer(relayKeyBuf)
            log('info', 'joined relay peer', { pubkey: info.pubkey.slice(0, 12) + '...' })
          } catch (err) {
            log('warn', 'joinPeer(relay) failed', { message: err && err.message })
          }
        }
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

    // Auto-join the configured room's swarm topic AND open its Autobases.
    // Gated by --no-auto-open (config.autoOpenRoom): when the flag is set
    // the peer boots straight to the lobby with no room mounted, and the
    // renderer drives the actual join via `room:join` IPC after the user
    // clicks Create or Join in the STADIUM directory. Skipping this pair
    // is what lets the demo start on the lobby instead of dropping into a
    // stale `demo-room` slug the operator never asked for.
    if (config.autoOpenRoom) {
      await joinRoom(config.roomSlug)
      await openRoomFor(config.roomSlug, config.isHost)
    } else {
      log('info', 'auto-open disabled; skipping default room join', { defaultSlug: config.roomSlug })
      emit('lobby:ready', { roomSlug: config.roomSlug, isHost: config.isHost })
    }

    // F3 (partial): boot the match live SSE consumer so goal / score events
    // from the backend drive the dock badge for the duration of the app
    // lifetime. Reconnects on its own; silently disables after 5 failures.
    matchLiveStreamConsumer.start()

    // Tier 4: subscribe the Supertonic announcer to the in-process match.goal
    // fanout. Off by default; behind CURVA_QVAC_TTS_ENABLED. Fire-and-forget
    // so a slow synth cannot back-pressure the SSE loop.
    if (announcerFlagEnabled) {
      ensureAnnouncer()
      matchLiveStreamConsumer.on('match.goal', (payload) => {
        if (!announcer) return
        const targets = announcerLocalesEnv || [announcerDefaultLocale]
        for (const targetLocale of targets) {
          announcer.speak({
            matchId: payload && payload.matchId,
            minute: payload && payload.minute,
            scorer: (payload && payload.scorer) || '',
            team: (payload && payload.team) || '',
            score: (payload && payload.newScore) || null,
            targetLocale
          })
            .then((audio) => {
              if (!audio) return
              emit('announcer:audio', audio)
            })
            .catch((err) => {
              log('warn', 'announcer.speak failed', {
                locale: targetLocale, message: err && err.message
              })
            })
        }
      })
    }
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
      // pear.assets branding pack: re-read Pear.app.assets.branding and
      // rebroadcast. Renderer calls this on a low-frequency timer until it
      // sees a non-null path, then stops. Docs describe no fetch-complete
      // event, so a pull-based refresh is the documented pattern.
      case 'assets:refresh': {
        emitBrandingSnapshot()
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
      case 'clip:link': {
        // Renderer asks for a loopback HTTP URL it can drop into <video src>.
        // The URL is served by hypercore-blob-server bound to 127.0.0.1 and
        // token-gated per process lifetime. Never expose the token separately;
        // it rides on the URL query string.
        if (!room) throw new RoomNotJoinedError()
        const driveKey = String(payload?.driveKey || '')
        const blobPath = String(payload?.blobPath || payload?.path || '')
        try {
          const link = room.clips.getClipLink(driveKey, blobPath)
          emit('clip:link', {
            url: link.url,
            token: link.token,
            expiresMs: link.expiresMs,
            port: link.port,
            host: link.host,
            driveKey,
            blobPath,
            requestId: id
          })
          emit('ack', { id, cmd })
        } catch (err) {
          emit('clip:link', {
            error: err?.message || 'clip link unavailable',
            code: err?.code || 'INTERNAL',
            driveKey,
            blobPath,
            requestId: id
          })
          throw err
        }
        return
      }

      // -- tactical drawing channel (Tier 3) ------------------------------
      // Renderer broadcasts strokes, presence, typing indicators and
      // freeze/unfreeze frames via these five IPC cases. Each maps 1:1 to a
      // room.sendTactical* method. The room enforces host-only for freeze /
      // unfreeze; non-host attempts are silently dropped there.
      case 'tactical:send-stroke': {
        if (!room) return
        try { room.sendTacticalStroke(payload) } catch (err) {
          log('warn', 'tactical stroke send failed', { error: err?.message })
        }
        return
      }
      case 'tactical:send-presence': {
        if (!room) return
        try { room.sendTacticalPresence(payload) } catch { /* noop */ }
        return
      }
      case 'tactical:send-typing': {
        if (!room) return
        try { room.sendTacticalTyping(payload) } catch { /* noop */ }
        return
      }
      case 'tactical:send-freeze': {
        if (!room) return
        try { room.sendTacticalFreeze(payload) } catch (err) {
          log('warn', 'tactical freeze send failed', { error: err?.message })
        }
        return
      }
      case 'tactical:send-unfreeze': {
        if (!room) return
        try { room.sendTacticalUnfreeze(payload) } catch (err) {
          log('warn', 'tactical unfreeze send failed', { error: err?.message })
        }
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
        // 2026-07-07: fall back to the local wallet's smart+owner addresses
        // when the renderer did not include them in the payload (RoomHeader
        // only passes handle+matchId today). The backend requires both.
        const walletSnap = walletInfoSnapshot()
        const res = await room.backend.publishRoom({
          slug: room.slug,
          matchId: payload?.matchId,
          hostHandle: payload?.hostHandle || identity.handle,
          hostSmartAddress: payload?.hostSmartAddress || walletSnap.smartAddress,
          hostOwnerAddress: payload?.hostOwnerAddress || walletSnap.ownerAddress,
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

      // -- Tier 4 Round 2 keet portable identity ------------------------
      // The identity uses the same passcode as the wallet (spec: one passcode
      // unlocks both blobs). If the wallet has not been initialized yet, all
      // four cases respond with IDENTITY_LOCKED so the renderer can prompt.
      case 'identity:has': {
        const enabled = keetIdentityFeatureEnabled()
        const present = !!(keetIdentity && keetIdentity.isLoaded())
        emit('ack', {
          id,
          cmd,
          payload: {
            enabled,
            present,
            identityPublicKey: present ? keetIdentity.getIdentityPublicKeyHex() : null
          }
        })
        return
      }
      case 'identity:generate-new': {
        if (!keetIdentityFeatureEnabled()) {
          emit('identity:error', { code: 'FEATURE_DISABLED', requestId: id })
          throw new Error('FEATURE_DISABLED')
        }
        if (!keetIdentityPasscode) {
          emit('identity:error', { code: 'IDENTITY_LOCKED', requestId: id })
          throw new Error('IDENTITY_LOCKED')
        }
        // Fresh mnemonic; the caller (renderer wizard) is responsible for
        // showing it once and dropping it. We overwrite any prior blob under
        // this passcode -- callers must confirm intent before calling.
        let SecretManager
        try {
          require('../bare/wallet/semverPatch.js').applyPatch()
          SecretManager = require('@tetherto/wdk-secret-manager', { with: { imports: 'bare-node-runtime/imports' } })
          SecretManager = SecretManager.default || SecretManager.WdkSecretManager || SecretManager
        } catch (err) {
          emit('identity:error', { code: 'DEPS_MISSING', message: err?.message, requestId: id })
          throw err
        }
        const handle = createKeetIdentity({
          SecretManager,
          storageDir: keetIdentityStorageDir(),
          log: (level, msg, meta) => log(level, '[keet] ' + msg, meta)
        })
        const res = await handle.loadOrGenerate({
          passphrase: keetIdentityPasscode,
          force: true
        })
        keetIdentity = handle
        setKeetIdentity(handle)
        // The mnemonic is emitted ONCE here; renderer must drop after display.
        // Deliberately not part of a persistent event stream — this is the ack.
        emit('ack', {
          id,
          cmd,
          payload: {
            mnemonic: res.mnemonic,
            identityPublicKey: res.identityPublicKeyHex
          }
        })
        emit('identity:ready', {
          identityPublicKey: res.identityPublicKeyHex,
          mnemonicGenerated: true
        })
        return
      }
      case 'identity:restore': {
        if (!keetIdentityFeatureEnabled()) {
          emit('identity:error', { code: 'FEATURE_DISABLED', requestId: id })
          throw new Error('FEATURE_DISABLED')
        }
        if (!keetIdentityPasscode) {
          emit('identity:error', { code: 'IDENTITY_LOCKED', requestId: id })
          throw new Error('IDENTITY_LOCKED')
        }
        const mnemonic = payload?.mnemonic
        if (typeof mnemonic !== 'string' || mnemonic.trim().split(/\s+/).length !== 24) {
          emit('identity:error', { code: 'MNEMONIC_INVALID', requestId: id })
          throw new RangeError('mnemonic must be 24 BIP-39 words')
        }
        let SecretManager
        try {
          require('../bare/wallet/semverPatch.js').applyPatch()
          SecretManager = require('@tetherto/wdk-secret-manager', { with: { imports: 'bare-node-runtime/imports' } })
          SecretManager = SecretManager.default || SecretManager.WdkSecretManager || SecretManager
        } catch (err) {
          emit('identity:error', { code: 'DEPS_MISSING', message: err?.message, requestId: id })
          throw err
        }
        const handle = createKeetIdentity({
          SecretManager,
          storageDir: keetIdentityStorageDir(),
          log: (level, msg, meta) => log(level, '[keet] ' + msg, meta)
        })
        const res = await handle.restore({
          mnemonic,
          passphrase: keetIdentityPasscode
        })
        keetIdentity = handle
        setKeetIdentity(handle)
        emit('ack', {
          id,
          cmd,
          payload: { identityPublicKey: res.identityPublicKeyHex }
        })
        emit('identity:ready', {
          identityPublicKey: res.identityPublicKeyHex,
          mnemonicGenerated: false
        })
        return
      }
      case 'identity:get-public-key': {
        const enabled = keetIdentityFeatureEnabled()
        const key = enabled && keetIdentity ? keetIdentity.getIdentityPublicKeyHex() : null
        emit('ack', { id, cmd, payload: { enabled, identityPublicKey: key } })
        return
      }
      // -- End Tier 4 Round 2 keet portable identity --------------------

      case 'tip:propose': {
        if (!room?.tip) throw new TipNotReadyError()
        const amount = String(payload?.amount ?? DEMO_AMOUNT_BASE_UNITS)
        const note = typeof payload?.note === 'string' ? payload.note : undefined
        const row = await room.tip.proposeTip({ amount, note })
        emit('ack', { id, cmd, payload: { status: row.status, tx_hash: row.tx_hash } })
        return
      }
      case 'tip:batch': {
        if (!room?.tip || typeof room.tip.tipBatch !== 'function') throw new TipNotReadyError()
        const row = await room.tip.tipBatch({ recipients: payload?.recipients })
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
        log('info', 'ipc translate:init', { targetLang })
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

      // ===== DEMO AUTOMATION (Tier polish) =====
      // One-button pitch driver. Host-only; feature-flag CURVA_DEMO_AUTOMATION_ENABLED.
      // Backing timeline lives in bare/demoTimeline.js. Every action here is a
      // passthrough into an already-shipped code path.
      case 'demo:start': {
        if (!room) throw new RoomNotJoinedError()
        const result = typeof room.triggerDemoTimeline === 'function'
          ? room.triggerDemoTimeline()
          : null
        emit('demo:status', result || { state: 'idle', elapsedMs: 0, currentStep: 0, totalSteps: 0 })
        emit('ack', { id, cmd, payload: result })
        return
      }
      case 'demo:stop': {
        if (!room) throw new RoomNotJoinedError()
        const result = typeof room.abortDemoTimeline === 'function'
          ? room.abortDemoTimeline()
          : { state: 'idle', elapsedMs: 0, currentStep: 0, totalSteps: 0 }
        emit('demo:status', result)
        emit('ack', { id, cmd, payload: result })
        return
      }
      case 'demo:status': {
        const result = (room && typeof room.demoTimelineStatus === 'function')
          ? room.demoTimelineStatus()
          : { state: 'idle', elapsedMs: 0, currentStep: 0, totalSteps: 0 }
        emit('demo:status', result)
        emit('ack', { id, cmd, payload: result })
        return
      }
      // ===== END DEMO AUTOMATION (Tier polish) =====

      // ===== SEMIFINAL QVAC DEPTH: RAG / MCP / DELEGATED IPC =====
      case 'rag:search': {
        const query = String(payload?.query || '').slice(0, 1024)
        if (query.length === 0) {
          emit('rag:error', { code: 'BAD_QUERY', message: 'query required', requestId: id })
          emit('ack', { id, cmd })
          return
        }
        const rag = await ensureRag()
        const opts = {}
        if (typeof payload?.topK === 'number') opts.topK = payload.topK | 0
        if (typeof payload?.kind === 'string') opts.kind = payload.kind
        const hits = await rag.search(query, opts)
        emit('rag:result', { query, hits, requestId: id })
        emit('ack', { id, cmd, payload: { count: hits.length } })
        return
      }
      case 'rag:ingest': {
        const rag = await ensureRag()
        const docs = Array.isArray(payload?.docs) ? payload.docs : []
        const opts = {}
        if (typeof payload?.kind === 'string') opts.kind = payload.kind
        const res = await rag.ingest(docs, opts)
        emit('rag:ingested', { ...res, requestId: id })
        emit('ack', { id, cmd, payload: res })
        return
      }
      case 'rag:status': {
        const rag = await ensureRag()
        emit('rag:status', { ...rag.status(), requestId: id })
        emit('ack', { id, cmd })
        return
      }
      case 'mcp:list': {
        const server = ensureMcpTools()
        const res = await server.client.listTools()
        emit('mcp:tools', { ...res, requestId: id })
        emit('ack', { id, cmd, payload: res })
        return
      }
      case 'mcp:call': {
        const server = ensureMcpTools()
        const name = String(payload?.name || '')
        const args = (payload && typeof payload.args === 'object' && payload.args) || {}
        try {
          const res = await server.client.callTool({ name, arguments: args })
          emit('mcp:result', { name, result: res, requestId: id })
          emit('ack', { id, cmd, payload: { name, ok: !res?.isError } })
        } catch (err) {
          emit('mcp:result', { name, error: err && err.message, requestId: id, isError: true })
          emit('ack', { id, cmd, payload: { name, ok: false } })
        }
        return
      }
      case 'delegated:list': {
        const reg = ensureDelegatedRegistry()
        const rows = await reg.listProviders()
        emit('delegated:list', { providers: rows, requestId: id })
        emit('ack', { id, cmd, payload: { count: rows.length } })
        return
      }
      case 'delegated:ping': {
        const reg = ensureDelegatedRegistry()
        const pubkey = String(payload?.pubkey || '')
        const res = await reg.pingProvider(pubkey)
        emit('delegated:ping-result', { pubkey, ...res, requestId: id })
        emit('ack', { id, cmd, payload: res })
        return
      }
      case 'delegated:set-firewall': {
        const reg = ensureDelegatedRegistry()
        const res = await reg.setFirewall({
          mode: payload?.mode === 'deny' ? 'deny' : 'allow',
          publicKeys: Array.isArray(payload?.publicKeys) ? payload.publicKeys : []
        })
        emit('delegated:firewall', { ...res, requestId: id })
        emit('ack', { id, cmd, payload: res })
        return
      }
      case 'delegated:snapshot': {
        const reg = ensureDelegatedRegistry()
        emit('delegated:snapshot', { ...reg.snapshot(), requestId: id })
        emit('ack', { id, cmd })
        return
      }
      // ===== END SEMIFINAL QVAC DEPTH =====

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
  try { matchLiveStreamConsumer.stop() } catch (err) {
    log('warn', 'matchLiveStreamConsumer stop failed', { message: err && err.message })
  }
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
  // Wave 13B: close roomBot. Only unloads the model if roomBot loaded it
  // itself (see `state.ownedUnloadModel` inside bare/roomBot.js) so we
  // don't double-free a handle shared with the commentator.
  try {
    if (roomBotChatUnsub) roomBotChatUnsub()
    if (roomBot) await roomBot.close()
  } catch (err) {
    log('warn', 'roomBot close failed', { message: err.message })
  }
  // Tier 4: close Supertonic announcer (unloads any per-locale TTS models).
  try {
    if (announcer) await announcer.close()
  } catch (err) {
    log('warn', 'announcer close failed', { message: err.message })
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
  // Wave 15 + ADR-003: quiesce blind-peering BEFORE closing the swarm so the
  // DHT sockets are torn down cleanly. suspend() is idempotent and safe on
  // no-op clients (see bare/blindPeering.js). close() also calls suspend()
  // internally as a belt-and-suspenders guard.
  try {
    if (blindPeering && typeof blindPeering.suspend === 'function') {
      await blindPeering.suspend()
    }
  } catch (err) {
    log('warn', 'blind-peering suspend failed', { message: err.message })
  }
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
