// Curva renderer bootstrap.
// Vanilla ES modules, no build step (ADR-001).
//
// Phase 4 lifecycle:
//   1. Boot splash is visible from index.html.
//   2. Start Bare worker. Splash status updates as worker log lines arrive.
//   3. On `ready`: hide splash, mount browser.
//   4. On `room:ready`: mount room components.
//   5. On `room:closed`/Leave: destroy room, re-show browser.
//   6. Every component mount is wrapped in an ErrorBoundary — a failed mount
//      never takes the whole app down.

import { BACKEND_URL, DEFAULT_ROOM } from './config.js'
import { mountVideoPlayer } from './components/VideoPlayer.js'
import { mountChat } from './components/Chat.js'
import { mountClipGallery } from './components/ClipGallery.js'
import { mountRoomHeader } from './components/RoomHeader.js'
import { mountRoomBrowser } from './components/RoomBrowser.js'
import { mountActivityFeed } from './components/ActivityFeed.js'
import { mountPasscodePrompt } from './components/PasscodePrompt.js'
import { mountActivityStrip } from './components/ActivityStrip.js'
import { mountLeaderboard } from './components/Leaderboard.js'
import { mountPredictionPanel, isPredictionPanelEnabled } from './components/PredictionPanel.js'
import { mountCommentaryPanel, isCommentaryPanelEnabled } from './components/CommentaryPanel.js'
import { mountTacticalOverlay } from './components/TacticalOverlay.js'
import { mountIdentityWizard } from './components/IdentityWizard.js'

const bridge = window.bridge
const curva = window.curva
if (!bridge || !curva) {
  const msg = document.createElement('pre')
  msg.style.color = '#ef4444'
  msg.style.padding = '32px'
  msg.textContent = 'bridge or curva unavailable. did preload load?'
  document.body.textContent = ''
  document.body.appendChild(msg)
  throw new Error('bridge missing')
}

const decoder = new TextDecoder('utf-8')
const MAIN_WORKER = '/workers/main.js'

const boot = bridge.bootConfig() || {}
const pkg = bridge.pkg() || {}

// Pear deep-link boot. When Curva is launched via
//   pear run pear://<KEY>/room/<slug>?invite=<base32url>
// `Pear.app.route` is `/room/<slug>` and `Pear.app.query` is `invite=...`.
// Docs: https://docs.pears.com/reference/pear/api/
//
// We prefer the pear:// route over the Electron curva:// fallback because the
// sidecar delivers it synchronously at boot, before any UI mount.
function readPearDeepLink() {
  const p = (typeof globalThis.Pear === 'object' && globalThis.Pear) || null
  const app = p && p.app
  if (!app || typeof app.route !== 'string') return null
  // route is unmapped, per docs (before pear.routes rewrites are applied).
  const m = app.route.match(/^\/room\/([A-Za-z0-9_-]+)\/?$/)
  if (!m) return null
  const slug = decodeURIComponent(m[1])
  const query = new URLSearchParams(app.query || '')
  const invite = query.get('invite') || null
  return { slug, invite }
}
const pearLink = readPearDeepLink()

const roomSlug = pearLink?.slug || boot.room || DEFAULT_ROOM
const isHost = !!boot.isHost
const backend = boot.backend || BACKEND_URL
const appVersion = boot.version || pkg.version || '0.0.0'

// Dev-mode flag: `?diag=1` in the URL (or `--diag` CLI flag forwarded via
// bootConfig) enables the diagnostics footer + a few extra devtools helpers.
const urlParams = new URLSearchParams(window.location.search)
const diagMode = urlParams.get('diag') === '1' || boot.diag === true

// Tactical drawing overlay feature flag. Off by default.
// Enable via: `?tactical=1` in dev URL or `CURVA_TACTICAL_ENABLED: true` in bootConfig.
const TACTICAL_ENABLED = !!boot.CURVA_TACTICAL_ENABLED || urlParams.get('tactical') === '1'

// Cup Final live-match minute overlay. On by default (safe/harmless: hides
// itself when no matchId is bound or when no pulse arrives). Explicit `false`
// in bootConfig OR `?live-minute=0` in dev URL disables.
const LIVE_MINUTE_OVERLAY_ENABLED =
  boot.CURVA_LIVE_MINUTE_OVERLAY_ENABLED !== false &&
  urlParams.get('live-minute') !== '0'

// -- boot splash handling --------------------------------------------------
const bootEl = document.querySelector('[data-boot]')
const bootStatusEl = document.querySelector('[data-boot-status]')
const bootHintEl = document.querySelector('[data-boot-hint]')

function setBootStatus(text, hint) {
  if (bootStatusEl && text) bootStatusEl.textContent = text
  if (bootHintEl && hint !== undefined) bootHintEl.textContent = hint || ''
}

function hideBootSplash() {
  if (!bootEl) return
  bootEl.classList.add('curva-boot--hide')
  setTimeout(() => { if (bootEl) bootEl.remove() }, 400)
}

// -- shell mount ------------------------------------------------------------

const app = document.getElementById('app')
const shellTpl = document.getElementById('app-shell')
app.appendChild(shellTpl.content.cloneNode(true))

const q = (sel) => app.querySelector(sel)
const els = {
  version: q('[data-version]'),
  topbarDht: q('[data-topbar="dht"]'),
  topbarPubkey: q('[data-topbar="pubkey"]'),
  browser: q('[data-mount="browser"]'),
  room: q('[data-mount="room"]'),
  roomHeader: q('[data-mount="room-header"]'),
  video: q('[data-mount="video"]'),
  chat: q('[data-mount="chat"]'),
  clips: q('[data-mount="clips"]'),
  feed: q('[data-mount="feed"]'),
  diag: q('[data-mount="diag"]'),
  log: q('[data-log]')
}

els.version.textContent = 'v' + appVersion

// Topbar debug items are only populated (and visible via CSS) in diag mode.
// The CSS rule `.curva-app--diag .curva-app__topbar-meta { display:flex }` gates
// visibility. We also populate them only in diagMode to avoid storing the pubkey
// in the DOM at all when diag is off.
if (diagMode) {
  const mainEl = app.querySelector('.curva-app')
  if (mainEl) mainEl.classList.add('curva-app--diag')
  els.topbarDht.textContent = 'dht: measuring...'
  els.topbarPubkey.textContent = 'pubkey: ...'
}

const state = {
  peerCount: 0,
  handle: null,
  pubkey: null,
  dhtMs: null,
  currentRoom: null
}

// -- ErrorBoundary ---------------------------------------------------------
// Vanilla JS "boundary": run `mountFn`, catch, log, render fallback.
function safeMount(name, mountFn, container) {
  try {
    return mountFn()
  } catch (err) {
    console.error('[Curva][ErrorBoundary]', name, err)
    logEvent('error', `component ${name} failed: ${err?.message || 'unknown'}`)
    if (container) {
      container.textContent = ''
      const fallback = document.createElement('div')
      fallback.className = 'curva-fallback'
      const title = document.createElement('div')
      title.className = 'curva-fallback__title'
      title.textContent = 'Component "' + name + '" failed to mount'
      const detail = document.createElement('div')
      detail.className = 'curva-fallback__detail'
      detail.textContent = err?.message || 'unknown error'
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'curva-fallback__btn'
      btn.textContent = 'Reload'
      btn.addEventListener('click', () => window.location.reload())
      fallback.appendChild(title)
      fallback.appendChild(detail)
      fallback.appendChild(btn)
      container.appendChild(fallback)
    }
    return null
  }
}

// -- component instances ----------------------------------------------------

let browserInstance = null
let roomHeader = null
let videoPlayer = null
let chat = null
let clipGallery = null
let activityFeed = null
let diagPanel = null
let leaderboard = null
// Wave 11: prediction panel is mounted only when CURVA_PREDICTIONS_ENABLED=true.
// The gate query lives in isPredictionPanelEnabled and races with a 4s timeout
// so a slow worker never blocks the room-ready render.
let predictionPanel = null
let predictionPanelHost = null
// Wave 13A: QVAC LLM commentator. Feature-flag gated in both the Bare worker
// AND here so a stale flag can never leak DOM into a locked-down build.
let commentaryPanel = null
let commentaryPanelHost = null
// C2: TacticalOverlay. Only mounted when TACTICAL_ENABLED.
let tacticalOverlay = null

// Tier 4 R2: IdentityWizard gate.
// Mount the wizard over the whole UI before the room browser is shown.
// The wizard resolves synchronously (skipped) when the keet identity feature
// is absent (curva.identity.generateNew not exposed), so this adds zero latency
// to non-identity builds.
let identityWizardHost = null
let identityWizardInstance = null

function runIdentityWizardThenBrowser() {
  if (identityWizardHost) {
    try { identityWizardHost.remove() } catch { /* noop */ }
    identityWizardHost = null
  }

  // Feature probe: if curva.identity.generateNew is not a function, the
  // IdentityWizard itself will call onComplete({skipped:true}) immediately.
  identityWizardHost = document.createElement('div')
  identityWizardHost.className = 'curva-identity-wizard-host'
  document.body.appendChild(identityWizardHost)

  identityWizardInstance = safeMount('IdentityWizard', () => mountIdentityWizard({
    container: identityWizardHost,
    curva,
    onComplete: (result) => {
      // Destroy and remove the wizard host before proceeding.
      if (identityWizardInstance) {
        try { identityWizardInstance.destroy() } catch { /* noop */ }
        identityWizardInstance = null
      }
      if (identityWizardHost) {
        try { identityWizardHost.remove() } catch { /* noop */ }
        identityWizardHost = null
      }
      if (result?.skipped) {
        logEvent('info', 'identity wizard: skipped (flag off or identity exists)')
      } else if (result?.restored) {
        logEvent('info', 'identity wizard: identity restored')
      } else {
        logEvent('info', 'identity wizard: identity created')
      }
      mountBrowser()
    }
  }), identityWizardHost)

  // Safety: if safeMount returns null (component threw), fall through to browser.
  if (!identityWizardInstance) {
    if (identityWizardHost) {
      try { identityWizardHost.remove() } catch { /* noop */ }
      identityWizardHost = null
    }
    mountBrowser()
  }
}

function mountBrowser() {
  destroyBrowser()
  browserInstance = safeMount('RoomBrowser', () => mountRoomBrowser({
    container: els.browser,
    curva,
    onJoin: (slug, host) => {
      curva.joinRoom(slug, !!host).catch((err) => {
        logEvent('error', 'joinRoom failed: ' + err.message)
      })
      logEvent('info', 'joining room=' + slug + (host ? ' (as host)' : ''))
      setBootStatus('Discovering peers…', 'This takes 5-45s on first launch')
    }
  }), els.browser)
  els.browser.hidden = false
  els.room.hidden = true
}

function destroyBrowser() {
  if (browserInstance) { try { browserInstance.destroy() } catch { /* noop */ } browserInstance = null }
}

function mountRoom(payload) {
  destroyRoom()
  state.currentRoom = {
    slug: payload.slug,
    isHost: payload.isHost,
    handle: payload.handle,
    hostSmartAddress: payload.hostSmartAddress || null
  }
  els.browser.hidden = true
  els.room.hidden = false

  roomHeader = safeMount('RoomHeader', () => mountRoomHeader({
    container: els.roomHeader,
    curva,
    roomState: state.currentRoom,
    appVersion,
    backendUrl: backend
  }), els.roomHeader)

  curva.initWallet().catch((err) => {
    logEvent('error', 'wallet init failed: ' + err.message)
  })

  videoPlayer = safeMount('VideoPlayer', () => mountVideoPlayer({
    container: els.video,
    curva,
    initialSource: '../assets/sample-clip.mp4',
    isHost: !!state.currentRoom?.isHost,
    matchId: state.currentRoom?.matchId || null,
    liveMinuteOverlayEnabled: LIVE_MINUTE_OVERLAY_ENABLED
  }), els.video)

  // C2: TacticalOverlay. Mounted on the video wrap so it sits over the video
  // element. Only activated when TACTICAL_ENABLED flag is set. The feature flag
  // avoids any canvas/ResizeObserver overhead in production builds.
  if (TACTICAL_ENABLED && videoPlayer && videoPlayer.wrap && videoPlayer.video) {
    tacticalOverlay = safeMount('TacticalOverlay', () => mountTacticalOverlay({
      container: videoPlayer.wrap,
      videoEl: videoPlayer.video,
      curva,
      isHost: !!state.currentRoom?.isHost
    }), null)
    if (videoPlayer.attachTacticalOverlay && tacticalOverlay) {
      videoPlayer.attachTacticalOverlay(tacticalOverlay)
    }
    logEvent('info', 'tactical overlay mounted (isHost=' + (state.currentRoom?.isHost ? 'yes' : 'no') + ')')
  }

  chat = safeMount('Chat', () => mountChat({
    container: els.chat,
    curva
  }), els.chat)

  clipGallery = safeMount('ClipGallery', () => mountClipGallery({
    container: els.clips,
    curva,
    videoPlayer
  }), els.clips)

  // Task 5: leaderboard alongside the chat panel. Mount into a sub-div
  // appended after chat so we do not need to change index.html markup.
  const lbHost = document.createElement('div')
  lbHost.className = 'curva-app__leaderboard'
  els.chat.parentNode.appendChild(lbHost)
  leaderboard = safeMount('Leaderboard', () => mountLeaderboard({
    container: lbHost,
    curva,
    matchId: payload.matchId
  }), lbHost)

  // Wave 11: PredictionPanel is mounted to the right of Chat, below RoomHeader.
  // Feature-flag gated at both the Bare worker (via CURVA_PREDICTIONS_ENABLED)
  // and here (via isPredictionPanelEnabled). If the flag is off, no DOM is
  // created and the layout collapses cleanly. matchId comes from the
  // room:ready payload; when null we still mount so the "join a room for a
  // match" hint renders.
  if (predictionPanelHost) { try { predictionPanelHost.remove() } catch { /* noop */ } predictionPanelHost = null }
  isPredictionPanelEnabled(curva).then((enabled) => {
    if (!enabled) {
      logEvent('info', 'predictions feature disabled; skipping panel mount')
      return
    }
    if (state.currentRoom == null) return // room may have closed while we awaited
    predictionPanelHost = document.createElement('div')
    predictionPanelHost.className = 'curva-app__predictions'
    els.chat.parentNode.appendChild(predictionPanelHost)
    predictionPanel = safeMount('PredictionPanel', () => mountPredictionPanel({
      container: predictionPanelHost,
      curva,
      roomState: {
        ...state.currentRoom,
        matchId: payload.matchId || state.currentRoom?.matchId || null,
        handle: payload.handle || null
      },
      appVersion
    }), predictionPanelHost)
    logEvent('info', 'prediction panel mounted (matchId=' + (payload.matchId || 'none') + ')')
  }).catch((err) => {
    logEvent('error', 'predictions flag check failed: ' + err.message)
  })

  // Wave 13A: CommentaryPanel mounted below RoomHeader / above Chat. Same
  // feature-flag gating pattern as PredictionPanel — nothing renders when the
  // Bare worker reports the flag off, so a shipped build with the flag off
  // has zero DOM overhead.
  if (commentaryPanelHost) { try { commentaryPanelHost.remove() } catch { /* noop */ } commentaryPanelHost = null }
  isCommentaryPanelEnabled(curva).then((enabled) => {
    if (!enabled) {
      logEvent('info', 'commentator feature disabled; skipping panel mount')
      return
    }
    if (state.currentRoom == null) return
    commentaryPanelHost = document.createElement('div')
    commentaryPanelHost.className = 'curva-app__commentary'
    // Place above Chat so the AI narration strip is visually adjacent to the
    // video. Falls back gracefully if the parent DOM tree is missing.
    if (els.chat && els.chat.parentNode) {
      els.chat.parentNode.insertBefore(commentaryPanelHost, els.chat)
    } else {
      document.body.appendChild(commentaryPanelHost)
    }
    commentaryPanel = safeMount('CommentaryPanel', () => mountCommentaryPanel({
      container: commentaryPanelHost,
      curva,
      roomState: state.currentRoom
    }), commentaryPanelHost)
    logEvent('info', 'commentary panel mounted (isHost=' + (state.currentRoom?.isHost ? 'yes' : 'no') + ')')
  }).catch((err) => {
    logEvent('error', 'commentator flag check failed: ' + err.message)
  })

  // Wave 14: Attendance ticket tools state mount. The chip + modal live in
  // RoomHeader; here we just kick off the initial config + list query so the
  // chip settles on the correct count within one round-trip of joining the
  // room. Errors are swallowed — the RoomHeader chip renders "Attendees · 0"
  // and stays hidden when the flag is off, so a failure has no user-visible
  // consequence.
  if (curva?.attendance?.getConfig) {
    curva.attendance.getConfig().catch(() => { /* noop */ })
  }
  if (curva?.attendance?.list) {
    curva.attendance.list({ limit: 200 }).catch(() => { /* noop */ })
  }
}

function destroyRoom() {
  if (tacticalOverlay) { try { tacticalOverlay.destroy() } catch { /* noop */ } tacticalOverlay = null }
  if (commentaryPanel) { try { commentaryPanel.destroy() } catch { /* noop */ } commentaryPanel = null }
  if (commentaryPanelHost) { try { commentaryPanelHost.remove() } catch { /* noop */ } commentaryPanelHost = null }
  if (predictionPanel) { try { predictionPanel.destroy() } catch { /* noop */ } predictionPanel = null }
  if (predictionPanelHost) { try { predictionPanelHost.remove() } catch { /* noop */ } predictionPanelHost = null }
  if (leaderboard) { try { leaderboard.destroy() } catch { /* noop */ } leaderboard = null }
  if (clipGallery) { try { clipGallery.destroy() } catch { /* noop */ } clipGallery = null }
  if (chat) { try { chat.destroy() } catch { /* noop */ } chat = null }
  if (videoPlayer) { try { videoPlayer.destroy() } catch { /* noop */ } videoPlayer = null }
  if (roomHeader) { try { roomHeader.destroy() } catch { /* noop */ } roomHeader = null }
  state.currentRoom = null
}

// Activity feed is always visible (independent of room state).
activityFeed = safeMount('ActivityFeed', () => mountActivityFeed({ container: els.feed, curva }), els.feed)

// Passcode prompt: shows when the Bare worker signals it needs a passcode
// to initialize the wallet. Mount lazily, unmount on wallet:ready.
let passcodePrompt = null
const passcodeHost = document.createElement('div')
document.body.appendChild(passcodeHost)
curva.onWalletPasscodeRequired?.(() => {
  if (passcodePrompt) return
  passcodePrompt = safeMount('PasscodePrompt', () => mountPasscodePrompt({
    container: passcodeHost,
    curva,
    onComplete: () => {
      logEvent('info', 'wallet passcode accepted; unlocking wallet...')
    }
  }), passcodeHost)
})
curva.onWalletReady?.(() => {
  if (!passcodePrompt) return
  try { passcodePrompt.destroy() } catch { /* noop */ }
  passcodePrompt = null
})

// Rolling activity strip: SSE-driven, mounted above the browser + room views.
// Hidden gracefully if the backend is unreachable.
const stripHost = document.createElement('div')
stripHost.className = 'curva-activitystrip-host'
els.room.parentNode.insertBefore(stripHost, els.room)
const activityStrip = safeMount('ActivityStrip', () => mountActivityStrip({
  container: stripHost,
  backendUrl: backend,
  curva
}), stripHost)

// Dev diag panel (D1).
if (diagMode) {
  diagPanel = mountDiagPanel(els.diag, curva)
  els.diag.hidden = false
}

// Task 9: deep-link auto-join. Electron main parses `curva://room/<slug>`
// and forwards to the renderer via `curva:deeplink:join`. We call
// curva.joinRoom directly. The slug is already sanitized by main.js.
curva.onDeepLinkJoin?.(({ slug }) => {
  if (typeof slug !== 'string' || slug.length === 0) return
  logEvent('info', 'deep-link join: ' + slug)
  curva.joinRoom(slug, false).catch((err) => {
    logEvent('error', 'deep-link joinRoom failed: ' + err.message)
  })
})

// pear.links auto-join. When Curva boots via
//   pear run pear://<KEY>/room/<slug>?invite=<base32url>
// the Pear sidecar populates `Pear.app.route` synchronously (see
// readPearDeepLink above). We wait for the worker ready signal so
// writerInvitation can verify the token, then auto-join.
if (pearLink) {
  logEvent('info', 'pear.link boot: slug=' + pearLink.slug +
    ' invite=' + (pearLink.invite ? 'yes' : 'no'))
  const autoJoin = () => {
    curva.joinRoom(pearLink.slug, false, { invite: pearLink.invite }).catch((err) => {
      logEvent('error', 'pear.link joinRoom failed: ' + err.message)
    })
  }
  if (typeof curva.onWorkerReady === 'function') {
    curva.onWorkerReady(autoJoin)
  } else {
    // Worker readiness bridge not yet exposed. Fall back to a small delay so
    // the worker has time to hydrate the writerInvitation module. If joinRoom
    // fires before the worker is ready, it will surface a clear error.
    setTimeout(autoJoin, 750)
  }
}

// T5: OTA update toast. Bottom-right, non-intrusive. Two phases:
//   - `update:available` -> "Curva vX.Y.Z is downloading"
//   - `update:ready`     -> "Update ready. Click to reload" (calls
//     bridge.applyUpdate to swap the drive, then window.location.reload)
;(function mountUpdateToast() {
  let toast = null
  function ensureToast() {
    if (toast) return toast
    toast = document.createElement('div')
    toast.className = 'curva-update-toast'
    // Inline critical styles so the toast works even before styles.css loads.
    toast.style.cssText = [
      'position:fixed',
      'bottom:20px',
      'right:20px',
      'background:#1e293b',
      'color:#f1f5f9',
      'padding:12px 16px',
      'border-radius:8px',
      'font-size:13px',
      'box-shadow:0 6px 24px rgba(0,0,0,0.3)',
      'z-index:9999',
      'max-width:320px',
      'cursor:default'
    ].join(';')
    document.body.appendChild(toast)
    return toast
  }
  function hideToast() {
    if (!toast) return
    try { toast.remove() } catch { /* noop */ }
    toast = null
  }
  curva.onUpdateAvailable?.((info) => {
    const el = ensureToast()
    el.textContent = 'Curva v' + (info?.version || 'update') + ' is downloading'
    el.style.cursor = 'default'
    logEvent('info', 'ota: download started v' + (info?.version || '?'))
  })
  curva.onUpdateReady?.((info) => {
    const el = ensureToast()
    el.textContent = 'Update v' + (info?.version || 'ready') + ' ready. Click to reload.'
    el.style.cursor = 'pointer'
    el.title = 'Click to swap the drive and reload'
    el.onclick = async () => {
      el.textContent = 'Reloading…'
      try {
        // template applyUpdate: worker calls pear.updater.applyUpdate()
        await bridge.applyUpdate().catch(() => { /* noop */ })
      } catch { /* noop */ }
      // Give the worker a beat to signal `pear:updateApplied`, then reload.
      setTimeout(() => { try { window.location.reload() } catch { /* noop */ } }, 400)
    }
    logEvent('info', 'ota: update ready; click toast to apply')
    // Auto-hide after 60s so it doesn't linger forever.
    setTimeout(hideToast, 60_000)
  })
})()

// Wire room lifecycle.
curva.onRoomReady((payload) => {
  logEvent('info', `room ready: ${payload.slug} (${payload.isHost ? 'host' : 'peer'})`)
  mountRoom(payload)
})

curva.onRoomClosed(() => {
  logEvent('info', 'room closed')
  destroyRoom()
  mountBrowser()
})

curva.onError((payload) => {
  logEvent('error', `worker error [${payload.cmd || 'general'}]: ${payload.message}`)
})

curva.onGoalCluster((payload) => {
  logEvent('info', `goal cluster: ${payload.count} msgs in ${payload.windowMs}ms`)
})

curva.onClipAdded((clip) => {
  logEvent('info', 'clip added ' + (clip.caption || '(no caption)'))
})

// -- logging ---------------------------------------------------------------

function logEvent(kind, text) {
  const li = document.createElement('li')
  li.className = 'evt-' + kind
  li.textContent = `[${new Date().toISOString().slice(11, 23)}] ${text}`
  els.log.appendChild(li)
  els.log.scrollTop = els.log.scrollHeight
  while (els.log.children.length > 200) {
    els.log.removeChild(els.log.firstChild)
  }
}

// -- worker IPC ------------------------------------------------------------

function parseWorkerMessage(buf) {
  const text = decoder.decode(buf)
  try {
    return JSON.parse(text)
  } catch {
    return { event: 'raw', payload: text }
  }
}

function handleWorkerEvent(msg) {
  const { event, payload } = msg
  switch (event) {
    case 'ready':
      state.handle = payload.handle
      state.pubkey = payload.pubkey
      // Topbar meta is only populated in diag mode (gated by CSS + this flag).
      if (diagMode) {
        els.topbarPubkey.textContent = 'pubkey: ' + short(payload.pubkey) + ' · handle: ' + payload.handle
      }
      logEvent('ready', `worker ready. pubkey=${short(payload.pubkey)}`)
      // Boot done — hide the splash, run the IdentityWizard (if the keet
      // identity feature is available), then reveal the browser.
      hideBootSplash()
      runIdentityWizardThenBrowser()
      break
    case 'peer:connected':
      state.peerCount = payload.count
      logEvent('peer-connected', `peer connected: ${short(payload.pubkey)} (total=${payload.count})`)
      break
    case 'peer:disconnected':
      state.peerCount = payload.count
      logEvent('peer-disconnected', `peer disconnected: ${short(payload.pubkey)} (total=${payload.count})`)
      break
    case 'dht:cold-start-time':
      state.dhtMs = payload.ms
      if (diagMode) {
        els.topbarDht.textContent = `dht: ${payload.ms} ms`
      }
      logEvent('info', `dht cold-start: ${payload.ms} ms`)
      setBootStatus('Syncing room state…', '')
      break
    case 'raw':
      logEvent('info', 'worker: ' + payload)
      break
    case 'error':
      logEvent('error', `worker error: ${payload?.message || 'unknown'}`)
      break
    default:
      // Silence event-stream noise; room components subscribe to their own topics.
  }
}

function short(hex) {
  if (typeof hex !== 'string') return String(hex)
  return hex.length > 12 ? hex.slice(0, 8) + '...' + hex.slice(-4) : hex
}

// -- diag panel (dev-only) -------------------------------------------------
function mountDiagPanel(container, curvaBridge) {
  container.textContent = ''
  container.classList.add('curva-diag')

  const title = document.createElement('span')
  title.className = 'curva-diag__title'
  title.textContent = 'DIAG'

  const backendItem = mkDiagItem('backend', '—')
  const swarmItem = mkDiagItem('swarm', '—')
  const walletItem = mkDiagItem('wallet', '—')
  const latencyItem = mkDiagItem('sync', '—')
  const chainItem = mkDiagItem('chain', '—')

  container.appendChild(title)
  container.appendChild(backendItem.el)
  container.appendChild(swarmItem.el)
  container.appendChild(walletItem.el)
  container.appendChild(latencyItem.el)
  container.appendChild(chainItem.el)

  function refresh() {
    curvaBridge.getHealth?.().catch(() => { /* noop */ })
    curvaBridge.getLatencies?.().catch(() => { /* noop */ })
  }

  const offHealth = curvaBridge.onHealth?.((h) => {
    backendItem.set(h.backendOk ? 'ok' : (h.backendStatus || 'down'))
    swarmItem.set(String(h.swarmPeers || 0) + ' peers')
    walletItem.set(h.walletReady ? 'ready' : 'idle')
    chainItem.set(String(h.chainId))
    if (h.latency?.count > 0) {
      latencyItem.set(`p50=${h.latency.p50}ms · p95=${h.latency.p95}ms · n=${h.latency.count}`)
    }
  }) || (() => {})

  const offSample = curvaBridge.onLatencySample?.(({ ms, type, from }) => {
    latencyItem.set(`${ms}ms (${type} from ${from})`)
    console.log(`[Curva][Diag] Playhead sync latency: ${ms}ms (type=${type} from=${from})`)
  }) || (() => {})

  refresh()
  const timer = setInterval(refresh, 15_000)

  function destroy() {
    clearInterval(timer)
    offHealth()
    offSample()
    container.textContent = ''
  }
  return { destroy }
}

function mkDiagItem(label, initial) {
  const el = document.createElement('span')
  el.className = 'curva-diag__item'
  const labelEl = document.createElement('span')
  labelEl.className = 'curva-diag__label'
  labelEl.textContent = label
  const valEl = document.createElement('span')
  valEl.className = 'curva-diag__val'
  valEl.textContent = initial
  el.appendChild(labelEl)
  el.appendChild(valEl)
  return {
    el,
    set: (v) => { valEl.textContent = String(v) }
  }
}

// -- boot ------------------------------------------------------------------

const offStdout = bridge.onWorkerStdout(MAIN_WORKER, (data) => {
  console.log('[worker stdout]', decoder.decode(data))
})
const offStderr = bridge.onWorkerStderr(MAIN_WORKER, (data) => {
  console.error('[worker stderr]', decoder.decode(data))
})
const offIPC = bridge.onWorkerIPC(MAIN_WORKER, (data) => {
  const msg = parseWorkerMessage(data)
  handleWorkerEvent(msg)
})
const offExit = bridge.onWorkerExit(MAIN_WORKER, (code) => {
  logEvent('error', `worker exited with code ${code}`)
  // Runtime crash UI (Phase 4 B3).
  showCrashOverlay(code)
  offStdout()
  offStderr()
  offIPC()
  offExit()
})

setBootStatus('Booting Curva runtime…', 'this may take 5-45s on first launch (DHT bootstrap)')
bridge.startWorker(MAIN_WORKER).catch((err) => {
  setBootStatus('Failed to start runtime', err?.message || 'unknown')
  logEvent('error', 'failed to start worker: ' + err.message)
})

logEvent('info', `booting curva v${appVersion} in room=${roomSlug} role=${isHost ? 'host' : 'peer'} backend=${backend}`)

// -- Demo automation floating button (dev-only) ---------------------------
// One-button pitch driver for the July 15 Cup Final demo. Gated on
// `boot.CURVA_DEMO_AUTOMATION_ENABLED` OR `?demo=1`. Renders a small floating
// button top-left. On click, calls `curva.demoTimeline.start()` and flips the
// label to a stop control while the timeline is running. Auto-hides when the
// timeline reports state:'finished'. All backend-sourced text is set via
// textContent (never innerHTML) to keep the XSS surface at zero.
const DEMO_AUTOMATION_ENABLED = !!boot.CURVA_DEMO_AUTOMATION_ENABLED
  || urlParams.get('demo') === '1'
if (DEMO_AUTOMATION_ENABLED && curva && curva.demoTimeline) {
  mountDemoAutomationButton()
}
function mountDemoAutomationButton() {
  const wrap = document.createElement('div')
  wrap.setAttribute('data-demo-automation', '')
  wrap.style.cssText = [
    'position:fixed', 'top:12px', 'left:12px', 'z-index:9999',
    'display:flex', 'flex-direction:column', 'gap:4px',
    'font-family:system-ui,-apple-system,sans-serif',
    'font-size:12px', 'user-select:none', 'pointer-events:auto'
  ].join(';')
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = 'Run demo'
  btn.style.cssText = [
    'height:24px', 'padding:0 10px', 'border:0', 'border-radius:4px',
    'background:#B0001A', 'color:#fff', 'font-weight:600', 'cursor:pointer',
    'box-shadow:0 1px 3px rgba(0,0,0,0.3)'
  ].join(';')
  const status = document.createElement('div')
  status.textContent = ''
  status.style.cssText = [
    'padding:2px 6px', 'background:rgba(0,0,0,0.6)', 'color:#fff',
    'border-radius:3px', 'min-height:14px'
  ].join(';')
  wrap.appendChild(btn)
  wrap.appendChild(status)
  document.body.appendChild(wrap)

  let running = false
  function renderTick(s) {
    // s is trusted (comes from our own worker) but we still stick to
    // textContent to keep the invariant "no innerHTML for backend data".
    if (!s) { status.textContent = ''; return }
    const secs = Math.floor((s.elapsedMs || 0) / 1000)
    status.textContent = 'elapsed: ' + secs + 's / step: ' + (s.currentStep || 0) + ' of ' + (s.totalSteps || 0)
    running = s.state === 'running'
    btn.textContent = running ? 'Stop demo' : 'Run demo'
    if (s.state === 'finished') {
      // Auto-hide after a short beat so the presenter sees the completion.
      setTimeout(() => {
        try { wrap.remove() } catch { /* noop */ }
      }, 3000)
    }
  }
  btn.addEventListener('click', async () => {
    try {
      if (running) {
        await curva.demoTimeline.stop()
      } else {
        await curva.demoTimeline.start()
      }
    } catch (err) {
      status.textContent = 'demo error: ' + (err && err.message ? String(err.message).slice(0, 60) : 'unknown')
    }
  })
  try { curva.onDemoTimelineTick(renderTick) } catch { /* noop */ }
  try { curva.onDemoTimelineStatus(renderTick) } catch { /* noop */ }
}

function showCrashOverlay(code) {
  const overlay = document.createElement('div')
  overlay.className = 'curva-crash'
  const box = document.createElement('div')
  box.className = 'curva-crash__box'
  const title = document.createElement('div')
  title.className = 'curva-crash__title'
  title.textContent = 'Runtime crashed'
  const detail = document.createElement('div')
  detail.className = 'curva-crash__detail'
  detail.textContent = 'The Bare worker exited with code ' + code + '. Restart Curva to try again.'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'curva-crash__btn'
  btn.textContent = 'Restart'
  btn.addEventListener('click', () => window.location.reload())
  box.appendChild(title)
  box.appendChild(detail)
  box.appendChild(btn)
  overlay.appendChild(box)
  document.body.appendChild(overlay)
}
