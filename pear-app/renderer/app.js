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
import { mountDelegatedInferencePanel, isDelegatedPanelEnabled } from './components/DelegatedInferencePanel.js'
import { mountTacticalOverlay } from './components/TacticalOverlay.js'
import { mountIdentityWizard } from './components/IdentityWizard.js'
import { mountVoiceCoachPanel, isVoiceCoachEnabled } from './components/VoiceCoachPanel.js'
import { mountFrameAnalyzePanel } from './components/FrameAnalyzePanel.js'
import { mountDiagnosticsPanel, isDiagnosticsEnabled } from './components/DiagnosticsPanel.js'
import { mountAskFrameOverlay } from './components/AskFrameOverlay.js'

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
  // Signal the CSS "page mount" animation to run once the shell is visible.
  // Wave 4 polish reads `body.curva-ready` to fade the app in and stagger the
  // panels. Purely presentational; safe to noop on reduced-motion.
  document.body.classList.add('curva-ready')
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
  topbarPeers: q('[data-topbar="peers"]'),
  topbarBlind: q('[data-topbar="blind"]'),
  topbarWallet: q('[data-topbar="wallet"]'),
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

// Topbar: peers badge always visible, updates on peer events.
function updatePeersBadge(count) {
  if (!els.topbarPeers) return
  els.topbarPeers.textContent = count + (count === 1 ? ' peer' : ' peers')
  els.topbarPeers.classList.toggle('curva-app__topbar-peers--live', count > 0)
}
updatePeersBadge(0)

// Topbar debug items are only populated (and visible via CSS) in diag mode.
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
// Mount generation counter. Incremented each mountRoom() call. Async
// panel mount callbacks capture the generation at call time and bail out
// if a newer mountRoom has run. Prevents duplicate panels when the user
// clicks Create room repeatedly.
let mountGeneration = 0
// Wave 13A: QVAC LLM commentator. Feature-flag gated in both the Bare worker
// AND here so a stale flag can never leak DOM into a locked-down build.
let commentaryPanel = null
let commentaryPanelHost = null
// Delegated inference panel: provider grid, firewall allow/deny, latency
// probes. Same feature-flag pattern as CommentaryPanel; mount is gated by
// isDelegatedPanelEnabled which checks the bare bridge exposes
// curva.delegated.snapshot().
let delegatedPanel = null
let delegatedPanelHost = null
// Cup Final: Voice-Controlled Coach. Same feature-flag pattern as Commentary;
// gated by isVoiceCoachEnabled which probes `curva.voiceCoach.status()`.
let voiceCoachPanel = null
let voiceCoachPanelHost = null
// Cup Final: FrameAnalyzePanel (VLM + OCR). Mounted next to VideoPlayer and
// driven by videoPlayer.captureFrame() + onPausedChange callback.
let frameAnalyzePanel = null
let frameAnalyzePanelHost = null
// Cup Final: DiagnosticsPanel (Metrics + Logs). Mounted into the activity
// strip container when observability is enabled.
let diagnosticsPanel = null
let diagnosticsPanelHost = null
// C2: TacticalOverlay. Only mounted when TACTICAL_ENABLED.
let tacticalOverlay = null
// F3: AskFrameOverlay. Mounted globally on body (not per-room) so the ?
// hotkey works from any context. Re-uses the current videoPlayer instance.
let askFrameOverlay = null

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
      // Race guard: if a room:ready arrived DURING the wizard flow (common in
      // demo mode where the worker auto-joins at boot before this callback
      // fires), do NOT clobber the mounted room with the lobby. Only mount
      // the lobby when we are not already inside a room.
      if (!state.currentRoom) mountBrowser()
    }
  }), identityWizardHost)

  // Safety: if safeMount returns null (component threw), fall through to browser.
  if (!identityWizardInstance) {
    if (identityWizardHost) {
      try { identityWizardHost.remove() } catch { /* noop */ }
      identityWizardHost = null
    }
    if (!state.currentRoom) mountBrowser()
  }
}

// Wave 17: pending post-join intent (used by "+ Create a new room" flow).
// When the lobby fires onJoin with { publish: true }, we stash the intent
// here so `onRoomReady` can auto-publish the room once the Autobase is
// spinning. Kept at module scope so a fast room:ready doesn't race the
// closure over the mountBrowser call.
let pendingPostJoin = null

function mountBrowser() {
  destroyBrowser()
  browserInstance = safeMount('RoomBrowser', () => mountRoomBrowser({
    container: els.browser,
    curva,
    onJoin: (slug, host, opts) => {
      // Only capture the intent when we're actually driving a fresh room open
      // (host=true from the "Create a new room" form). Discovery-based joins
      // never publish because the host owns publication rights.
      if (host && opts && opts.publish) {
        pendingPostJoin = {
          slug,
          publish: true,
          displayName: opts.displayName || null
        }
      } else if (host && opts && opts.displayName) {
        // Preserve the display name even without publish so the room header
        // can render it later if we plumb it there.
        pendingPostJoin = { slug, publish: false, displayName: opts.displayName }
      } else {
        pendingPostJoin = null
      }
      curva.joinRoom(slug, !!host).catch((err) => {
        logEvent('error', 'joinRoom failed: ' + err.message)
        pendingPostJoin = null
      })
      logEvent('info', 'joining room=' + slug + (host ? ' (as host)' : '') + (opts?.publish ? ' publish=directory' : ''))
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
  const myGeneration = ++mountGeneration
  // Wave 17 UX: if the host created this room through the "+ Create a new
  // room" form with a display name, surface it as the room title in
  // RoomHeader. Falls back to the slug for viewers and legacy joins.
  const displayName = (pendingPostJoin && pendingPostJoin.slug === payload.slug && pendingPostJoin.displayName)
    ? pendingPostJoin.displayName
    : null
  state.currentRoom = {
    slug: payload.slug,
    isHost: payload.isHost,
    handle: payload.handle,
    hostSmartAddress: payload.hostSmartAddress || null,
    displayName
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

  // Post-mount surgery: move the tip form OUT of the room header and BELOW
  // the video. Idempotent: removes any prior tip panels before mounting a
  // fresh one so repeated mountRoom cycles don't stack duplicate "SEND A TIP"
  // panels. Only inserts if `.curva-header__tip` is present (broken flags
  // path silently skips).
  setTimeout(() => {
    // Clean up any leftover tip panels from prior mounts.
    document.querySelectorAll('.curva-app__tip-panel').forEach((n) => {
      try { n.remove() } catch { /* noop */ }
    })
    const tip = document.querySelector('.curva-header__tip')
    const videoEl = els.video
    if (tip && videoEl && videoEl.parentNode) {
      const tipPanel = document.createElement('section')
      tipPanel.className = 'curva-app__tip-panel'
      tipPanel.appendChild(tip)
      videoEl.parentNode.insertBefore(tipPanel, videoEl.nextSibling)
    }
  }, 0)

  curva.initWallet().catch((err) => {
    logEvent('error', 'wallet init failed: ' + err.message)
  })

  // Video source. Defaults to the placeholder sample-clip.mp4 that ships with
  // the app. For a real World Cup demo, drop a video into pear-app/assets/
  // (any browser-playable format: mp4/webm/mov) and set CURVA_DEMO_VIDEO_PATH
  // to '../assets/<filename>' via the demo runner, or override at ?video= in
  // the URL for a one-off. `?video=` supports both relative (../assets/foo.mp4)
  // and absolute (https://... or file://...) URLs. Absolute URLs are validated
  // by the URL constructor; malformed values fall back to the default clip.
  const defaultVideo = '../assets/sample-clip.mp4'
  const envVideo = boot.CURVA_DEMO_VIDEO_PATH || null
  const urlVideo = urlParams.get('video') || null
  let videoSource = defaultVideo
  const candidate = urlVideo || envVideo
  if (candidate) {
    if (candidate.startsWith('../') || candidate.startsWith('./')) {
      videoSource = candidate
    } else {
      try {
        const parsed = new URL(candidate)
        if (parsed.protocol === 'https:' || parsed.protocol === 'file:') {
          videoSource = parsed.toString()
        }
      } catch { /* invalid URL — keep the default */ }
    }
  }
  videoPlayer = safeMount('VideoPlayer', () => mountVideoPlayer({
    container: els.video,
    curva,
    initialSource: videoSource,
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
    if (myGeneration !== mountGeneration) return // a newer mountRoom ran; skip
    if (predictionPanelHost != null) return // already mounted by an earlier fast path
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
    if (myGeneration !== mountGeneration) return // a newer mountRoom ran; skip
    if (commentaryPanelHost != null) return // already mounted by an earlier fast path
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

  // Delegated inference panel mounted below Chat. Same feature-flag pattern
  // as CommentaryPanel. Uses curva.delegated bridge (electron/preload.js)
  // which fans out to bare/delegatedProvider.js and the Hyperbee provider
  // index. Panel is fully additive — nothing renders if the bridge is
  // unavailable or the snapshot call times out.
  if (delegatedPanelHost) { try { delegatedPanelHost.remove() } catch { /* noop */ } delegatedPanelHost = null }
  isDelegatedPanelEnabled(curva).then((enabled) => {
    if (myGeneration !== mountGeneration) return
    if (delegatedPanelHost != null) return
    if (!enabled) {
      logEvent('info', 'delegated inference bridge unavailable; skipping panel mount')
      return
    }
    if (state.currentRoom == null) return
    delegatedPanelHost = document.createElement('div')
    delegatedPanelHost.className = 'curva-app__delegated'
    // Place below Chat so the provider grid does not compete with the primary
    // conversation surface. Falls back to body append if chat is missing.
    if (els.chat && els.chat.parentNode) {
      els.chat.parentNode.appendChild(delegatedPanelHost)
    } else {
      document.body.appendChild(delegatedPanelHost)
    }
    delegatedPanel = safeMount('DelegatedInferencePanel', () => mountDelegatedInferencePanel({
      container: delegatedPanelHost,
      curva,
      roomState: state.currentRoom
    }), delegatedPanelHost)
    logEvent('info', 'delegated inference panel mounted (isHost=' + (state.currentRoom?.isHost ? 'yes' : 'no') + ')')
  }).catch((err) => {
    logEvent('error', 'delegated panel gate check failed: ' + err.message)
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

  // Cup Final: VoiceCoachPanel mounted below Chat. Feature-flag gated. Same
  // gating pattern as CommentaryPanel (Promise.race against a 3s timeout
  // inside isVoiceCoachEnabled) so a slow SDK probe never blocks room:ready.
  if (voiceCoachPanelHost) { try { voiceCoachPanelHost.remove() } catch { /* noop */ } voiceCoachPanelHost = null }
  isVoiceCoachEnabled(curva).then((enabled) => {
    if (myGeneration !== mountGeneration) return
    if (voiceCoachPanelHost != null) return
    if (!enabled) {
      logEvent('info', 'voice coach disabled; skipping panel mount')
      return
    }
    if (state.currentRoom == null) return
    voiceCoachPanelHost = document.createElement('div')
    voiceCoachPanelHost.className = 'curva-app__voice-coach'
    if (els.chat && els.chat.parentNode) {
      els.chat.parentNode.appendChild(voiceCoachPanelHost)
    } else {
      document.body.appendChild(voiceCoachPanelHost)
    }
    voiceCoachPanel = safeMount('VoiceCoachPanel', () => mountVoiceCoachPanel({
      container: voiceCoachPanelHost,
      curva,
      roomState: state.currentRoom
    }), voiceCoachPanelHost)
    logEvent('info', 'voice coach panel mounted')
  }).catch((err) => {
    logEvent('error', 'voice coach flag check failed: ' + err.message)
  })

  // Cup Final: FrameAnalyzePanel mounted below the VideoPlayer. Gated on the
  // presence of BOTH curva.vlm and curva.ocr bridges (preload wires them
  // unconditionally, but the panel itself hides the individual button when a
  // bridge is absent). Uses videoPlayer.captureFrame() to grab a PNG data URL
  // and routes the caption/OCR text back into chat via the scoped
  // curva.chat.sendSystem bridge.
  if (frameAnalyzePanelHost) { try { frameAnalyzePanelHost.remove() } catch { /* noop */ } frameAnalyzePanelHost = null }
  if (curva?.vlm && curva?.ocr && videoPlayer && typeof videoPlayer.captureFrame === 'function') {
    frameAnalyzePanelHost = document.createElement('div')
    frameAnalyzePanelHost.className = 'curva-app__frame-analyze'
    if (els.video && els.video.parentNode) {
      els.video.parentNode.insertBefore(frameAnalyzePanelHost, els.video.nextSibling)
    } else {
      document.body.appendChild(frameAnalyzePanelHost)
    }
    frameAnalyzePanel = safeMount('FrameAnalyzePanel', () => mountFrameAnalyzePanel({
      container: frameAnalyzePanelHost,
      curva,
      getFrame: () => videoPlayer.captureFrame(),
      onSystemMessage: (text, source) => {
        // Route the caption / OCR summary back into chat as a system pill.
        // Peers see them alongside their own screen-analysis output.
        const type = source === 'vlm' ? 'system:vlm-caption' : 'system:ocr-read'
        const matchTimeMs = (() => {
          try { return videoPlayer && videoPlayer.video ? Math.floor(videoPlayer.video.currentTime * 1000) : 0 } catch { return 0 }
        })()
        curva.chat.sendSystem({ type, text: String(text || '').slice(0, 800), match_time_ms: matchTimeMs })
          .catch((err) => logEvent('warn', 'chat.sendSystem (' + type + ') failed: ' + (err?.message || 'unknown')))
      }
    }), frameAnalyzePanelHost)
    // Wire the video's paused-state callback so buttons enable only while paused.
    if (videoPlayer && videoPlayer.video && frameAnalyzePanel && typeof frameAnalyzePanel.setPaused === 'function') {
      // Seed initial state (VideoPlayer only fires onPausedChange on transition).
      try { frameAnalyzePanel.setPaused(!!videoPlayer.video.paused) } catch { /* noop */ }
      const onPause = () => { try { frameAnalyzePanel.setPaused(true) } catch { /* noop */ } }
      const onPlay = () => { try { frameAnalyzePanel.setPaused(false) } catch { /* noop */ } }
      videoPlayer.video.addEventListener('pause', onPause)
      videoPlayer.video.addEventListener('play', onPlay)
      // Store unbind closures on the panel host so destroyRoom can clean them up.
      frameAnalyzePanelHost._curvaVideoUnbind = () => {
        try { videoPlayer.video.removeEventListener('pause', onPause) } catch { /* noop */ }
        try { videoPlayer.video.removeEventListener('play', onPlay) } catch { /* noop */ }
      }
    }
    logEvent('info', 'frame analyze panel mounted')
  }
}

function destroyRoom() {
  if (tacticalOverlay) { try { tacticalOverlay.destroy() } catch { /* noop */ } tacticalOverlay = null }
  if (frameAnalyzePanelHost && typeof frameAnalyzePanelHost._curvaVideoUnbind === 'function') {
    try { frameAnalyzePanelHost._curvaVideoUnbind() } catch { /* noop */ }
    frameAnalyzePanelHost._curvaVideoUnbind = null
  }
  if (frameAnalyzePanel) { try { frameAnalyzePanel.destroy() } catch { /* noop */ } frameAnalyzePanel = null }
  if (frameAnalyzePanelHost) { try { frameAnalyzePanelHost.remove() } catch { /* noop */ } frameAnalyzePanelHost = null }
  if (voiceCoachPanel) { try { voiceCoachPanel.destroy() } catch { /* noop */ } voiceCoachPanel = null }
  if (voiceCoachPanelHost) { try { voiceCoachPanelHost.remove() } catch { /* noop */ } voiceCoachPanelHost = null }
  if (delegatedPanel) { try { delegatedPanel.destroy() } catch { /* noop */ } delegatedPanel = null }
  if (delegatedPanelHost) { try { delegatedPanelHost.remove() } catch { /* noop */ } delegatedPanelHost = null }
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

// F3: AskFrameOverlay. Global singleton on document.body.
// getVideoPlayer closure gives the overlay access to the current room's
// videoPlayer without holding a stale reference across room transitions.
if (curva.askFrame) {
  askFrameOverlay = safeMount('AskFrameOverlay', () => mountAskFrameOverlay({
    container: document.body,
    curva,
    getVideoPlayer: () => videoPlayer
  }), null)
}

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

// Cup Final: DiagnosticsPanel (Metrics + Logs). Feature-flag gated behind the
// Bare worker's observability status; when CURVA_OBSERVABILITY_ENABLED != true
// the status probe reports { enabled: false } and no DOM is mounted. Uses a
// dedicated host element appended below the activity feed so it never fights
// with the room / browser layout.
isDiagnosticsEnabled(curva).then((enabled) => {
  if (!enabled) {
    logEvent('info', 'observability disabled; skipping diagnostics panel mount')
    return
  }
  if (diagnosticsPanelHost) return
  diagnosticsPanelHost = document.createElement('div')
  diagnosticsPanelHost.className = 'curva-app__diagnostics'
  if (els.feed && els.feed.parentNode) {
    els.feed.parentNode.appendChild(diagnosticsPanelHost)
  } else {
    document.body.appendChild(diagnosticsPanelHost)
  }
  diagnosticsPanel = safeMount('DiagnosticsPanel', () => mountDiagnosticsPanel({
    container: diagnosticsPanelHost,
    curva
  }), diagnosticsPanelHost)
  logEvent('info', 'diagnostics panel mounted')
}).catch((err) => {
  logEvent('warn', 'diagnostics flag check failed: ' + (err?.message || 'unknown'))
})

// Wave 3 F1: log streaming TTS lifecycle so DiagnosticsPanel picks them up.
// We intentionally do NOT decode + play PCM here — the commentator already
// emits the PCM via the announcer's `announcer:audio` path where relevant.
// Every subscriber is best-effort (no throw) so an older worker without the
// event surface degrades to a silent no-op.
try {
  curva.commentator?.onTtsChunk?.((payload) => {
    if (!payload) return
    const bytes = payload && payload.pcm ? payload.pcm.length : 0
    logEvent('info', 'commentator tts-chunk bytes=' + bytes)
  })
  curva.commentator?.onTtsDone?.(() => {
    logEvent('info', 'commentator tts-done')
  })
  curva.commentator?.onTtsError?.((payload) => {
    logEvent('warn', 'commentator tts-error: ' + (payload?.message || 'unknown'))
  })
  curva.onAnnouncerTtsFirstChunk?.((payload) => {
    logEvent('info', 'announcer tts-first-chunk latencyMs=' + (payload?.latencyMs ?? 'n/a'))
  })
} catch (err) {
  logEvent('warn', 'wave3 tts subscribe failed: ' + (err?.message || 'unknown'))
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

// Feature 3 (HUD overlay): floating live-primitives status panel for demos.
// Only visible when CURVA_DEMO_HUD_ENABLED=true (boot config) or ?hud=1 URL.
// Security: all text is set via textContent. No innerHTML. No peer data.
;(function mountHud() {
  const HUD_ENABLED = !!boot.CURVA_DEMO_HUD_ENABLED || urlParams.get('hud') === '1'
  if (!HUD_ENABLED) return

  const hud = document.createElement('div')
  hud.className = 'curva-hud'
  hud.style.cssText = [
    'position:fixed',
    'bottom:24px',
    'right:24px',
    'background:rgba(0,0,0,0.82)',
    'color:#e2e8f0',
    'padding:10px 14px',
    'border-radius:6px',
    'font-size:12px',
    'font-family:monospace',
    'line-height:1.6',
    'z-index:8888',
    'min-width:220px',
    'border:1px solid rgba(255,255,255,0.08)',
    'pointer-events:none'
  ].join(';')
  document.body.appendChild(hud)

  // One line per pillar. textContent only — all values are local state.
  function mkLine(label) {
    const row = document.createElement('div')
    row.className = 'curva-hud__row'
    const lbl = document.createElement('span')
    lbl.className = 'curva-hud__label'
    lbl.style.cssText = 'color:#94a3b8;margin-right:6px'
    lbl.textContent = label + ':'
    const val = document.createElement('span')
    val.className = 'curva-hud__val'
    val.textContent = '—'
    row.appendChild(lbl)
    row.appendChild(val)
    hud.appendChild(row)
    return { set: (v) => { val.textContent = String(v) } }
  }

  const swarmLine    = mkLine('swarm peers')
  const blindLine    = mkLine('blind peer')
  const writersLine  = mkLine('autobase writers')
  const updaterLine  = mkLine('pear updater')
  const walletLine   = mkLine('WDK wallet')
  const identityLine = mkLine('keet identity')

  // Initial values
  swarmLine.set(String(state.peerCount))
  updaterLine.set('idle')
  walletLine.set('—')
  identityLine.set('—')

  // swarm peers: piggyback existing peer:connected/peer:disconnected
  curva.onPeerConnected?.((p) => swarmLine.set(String(p.count)))
  curva.onPeerDisconnected?.((p) => swarmLine.set(String(p.count)))

  // blind peer: pull from blindPeering:registration or blindPeering:status
  if (typeof curva.blindPeering?.getStatus === 'function') {
    curva.blindPeering.getStatus().catch(() => {})
  }
  curva.blindPeering?.onStatus?.((s) => {
    blindLine.set(s?.active ? 'active' : 'inactive')
  })
  curva.blindPeering?.onRegistration?.((r) => {
    const st = r?.status
    blindLine.set(st?.active ? 'active' : 'inactive')
  })

  // autobase writers: room:writers-update
  if (typeof curva.onWritersUpdate === 'function') {
    curva.onWritersUpdate((p) => {
      const count = typeof p?.writerCount === 'number' ? p.writerCount : 0
      writersLine.set(String(count))
    })
  }

  // pear updater: onUpdateAvailable / onUpdateReady
  curva.onUpdateAvailable?.(() => updaterLine.set('updating'))
  curva.onUpdateReady?.(() => updaterLine.set('ready'))

  // WDK wallet
  curva.onWalletReady?.(() => walletLine.set('ready'))
  curva.onWalletError?.(() => walletLine.set('error'))

  // keet identity
  curva.identity?.onIdentityReady?.((p) => {
    identityLine.set(p?.identityPublicKey ? 'verified' : 'ready')
  })
  curva.identity?.onIdentityError?.(() => identityLine.set('error'))
  // Also try a direct query on load
  if (typeof curva.identity?.hasKeetIdentity === 'function') {
    curva.identity.hasKeetIdentity().then((res) => {
      if (res?.present) identityLine.set('verified')
      else if (res?.enabled) identityLine.set('pending')
    }).catch(() => {})
  }
})()

// Topbar: blind peer indicator dot (shown when active).
// Security: textContent only; no user data exposed.
;(function wireTopbarIndicators() {
  // Blind peer: show dot when active
  function setBlindPeer(active) {
    if (!els.topbarBlind) return
    if (active) {
      els.topbarBlind.textContent = 'blind peer'
      els.topbarBlind.removeAttribute('hidden')
    } else {
      els.topbarBlind.setAttribute('hidden', '')
    }
  }
  curva.blindPeering?.onStatus?.((s) => setBlindPeer(!!s?.active))
  curva.blindPeering?.onRegistration?.((r) => setBlindPeer(!!r?.status?.active))

  // Wallet: show short address chip when ready
  function setWallet(address) {
    if (!els.topbarWallet) return
    if (address) {
      const short = address.slice(0, 6) + '…' + address.slice(-4)
      els.topbarWallet.textContent = short
      els.topbarWallet.removeAttribute('hidden')
    }
  }
  curva.onWalletReady?.((info) => {
    const addr = info?.address || info?.walletAddress || ''
    if (addr) setWallet(addr)
  })
})()

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

// Feature 1 (WC reel on Hyperdrive): swap VideoPlayer src when the P2P link
// arrives. 3-second fallback: if no wc-reel:link event fires before the timer,
// the VideoPlayer keeps its local file source. textContent/setAttribute only —
// the URL is a loopback http://127.0.0.1 URL from hypercore-blob-server.
let wcReelFallbackTimer = null
if (typeof curva.onWcReelLink === 'function') {
  curva.onWcReelLink((payload) => {
    if (wcReelFallbackTimer) { clearTimeout(wcReelFallbackTimer); wcReelFallbackTimer = null }
    // Validate: must be a loopback http URL (hypercore-blob-server only binds 127.0.0.1)
    if (typeof payload?.url !== 'string') return
    try {
      const u = new URL(payload.url)
      if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) return
    } catch { return }
    if (videoPlayer && typeof videoPlayer.setSource === 'function') {
      videoPlayer.setSource(payload.url)
      logEvent('info', 'wc-reel P2P link applied: ' + payload.url.slice(0, 60))
    }
  })
}

// Wire room lifecycle.
curva.onRoomReady((payload) => {
  logEvent('info', `room ready: ${payload.slug} (${payload.isHost ? 'host' : 'peer'})`)
  // Start 3-second fallback timer for the WC reel link.
  if (wcReelFallbackTimer) clearTimeout(wcReelFallbackTimer)
  wcReelFallbackTimer = setTimeout(() => {
    wcReelFallbackTimer = null
    // Do nothing — VideoPlayer already has the local file as initial source.
    logEvent('info', 'wc-reel fallback: keeping local file (P2P link did not arrive in 3s)')
  }, 3000)
  mountRoom(payload)

  // Wave 17: honour the lobby's pending post-join intent. Only host peers
  // can publish; we still guard on payload.isHost to be safe (the worker is
  // authoritative on the isHost bit).
  const intent = pendingPostJoin
  pendingPostJoin = null
  if (intent && intent.slug === payload.slug && intent.publish && payload.isHost) {
    logEvent('info', 'auto-publishing room to STADIUM directory (create-form intent)')
    curva.publishRoom({}).then((res) => {
      if (res && res.ok !== false) {
        logEvent('info', 'room published to directory')
      } else {
        logEvent('warn', 'publishRoom failed: ' + (res?.error || 'unknown'))
      }
    }).catch((err) => {
      logEvent('warn', 'publishRoom threw: ' + err.message)
    })
  }
})

curva.onRoomClosed(() => {
  logEvent('info', 'room closed')
  destroyRoom()
  mountBrowser()
})

// Silence noisy repeated errors (translation retries, chat/clip boot-race
// probes). Judges and the presenter don't need to see 100+ identical lines
// scroll past. Everything is still surfaced to console for debugging.
const SILENT_ERROR_PATTERNS = [
  /translation is disabled/i,
  /translation.*not initialized/i,
  /room not joined/i,
  /wallet not initialized/i
]
curva.onError((payload) => {
  const msg = String(payload?.message || '')
  if (SILENT_ERROR_PATTERNS.some((re) => re.test(msg))) {
    console.debug('[curva] silenced error', payload?.cmd, msg)
    return
  }
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
      updatePeersBadge(payload.count)
      logEvent('peer-connected', `peer connected: ${short(payload.pubkey)} (total=${payload.count})`)
      break
    case 'peer:disconnected':
      state.peerCount = payload.count
      updatePeersBadge(payload.count)
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
    case 'error': {
      const errMsg = String(payload?.message || 'unknown')
      if (SILENT_ERROR_PATTERNS.some((re) => re.test(errMsg))) {
        console.debug('[curva] silenced worker error', errMsg)
        break
      }
      logEvent('error', `worker error: ${errMsg}`)
      break
    }
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

// Boot splash safety timeout. In the 4-peer demo path, all four windows share
// a single Bare worker (see electron/main.js getWorker singleton), so the
// worker's `ready` event fires exactly once. Only the first-connected window
// receives it; later windows subscribe after the emit and stay on the splash
// forever. Guard against this by force-dismissing the splash after 8s and
// running the identity wizard / browser mount so the user always reaches a
// usable UI. Real single-window boots hit this too if the DHT is unusually
// slow (>8s), but the flow degrades gracefully because subsequent worker
// events still fire against the mounted browser.
setTimeout(() => {
  if (bootEl && !bootEl.classList.contains('curva-boot--hide')) {
    logEvent('warn', 'boot splash safety timeout fired; proceeding without worker:ready')
    hideBootSplash()
    runIdentityWizardThenBrowser()
  }
}, 8000)

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
  // Moved to top-right so it stops overlapping the CURVA wordmark logo in the
  // topbar. The topbar chips (peers/blind/wallet/version) sit on the right too;
  // this button anchors below them via a slight y-offset so they don't collide.
  wrap.style.cssText = [
    'position:fixed', 'top:56px', 'right:16px', 'z-index:9999',
    'display:flex', 'flex-direction:column', 'align-items:flex-end', 'gap:6px',
    'font-family:inherit', 'font-size:12px', 'user-select:none', 'pointer-events:auto'
  ].join(';')
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = 'Run demo'
  // Match the primary CTA tier in the polish block: solid Torino red, subtle
  // inner highlight, soft red glow. No !important here — the class-less inline
  // style is trumped by the .curva-btn--primary rule if we ever migrate.
  btn.style.cssText = [
    'height:30px', 'padding:0 14px', 'border:1px solid #c8102e', 'border-radius:8px',
    'background:#c8102e', 'color:#fff', 'font-weight:600', 'font-size:12px',
    'letter-spacing:0.01em', 'cursor:pointer',
    'box-shadow:inset 0 1px 0 rgba(255,255,255,0.12), 0 6px 20px rgba(200,16,46,0.28), 0 1px 2px rgba(0,0,0,0.4)',
    'transition:transform 120ms ease-out, background 160ms ease-out'
  ].join(';')
  btn.addEventListener('mouseenter', () => { btn.style.background = '#a80d26' })
  btn.addEventListener('mouseleave', () => { btn.style.background = '#c8102e' })
  const status = document.createElement('div')
  status.textContent = ''
  status.style.cssText = [
    'padding:3px 8px', 'background:rgba(10,10,10,0.72)', 'color:#d0d6e0',
    'border:1px solid rgba(255,255,255,0.08)', 'border-radius:6px',
    'font-family:ui-monospace,SF Mono,Menlo,monospace', 'font-size:10px',
    'letter-spacing:0.02em', 'min-height:14px',
    'backdrop-filter:blur(8px)', '-webkit-backdrop-filter:blur(8px)'
  ].join(';')
  wrap.appendChild(btn)
  wrap.appendChild(status)
  document.body.appendChild(wrap)

  let running = false
  // Status line stays hidden until the demo is actually running. Prior UI
  // showed "elapsed: 0s / step: 0 of 0" on idle which looked broken.
  status.style.display = 'none'
  function renderTick(s) {
    if (!s) { status.textContent = ''; status.style.display = 'none'; return }
    running = s.state === 'running'
    btn.textContent = running ? 'Stop demo' : 'Run demo'
    if (running) {
      const secs = Math.floor((s.elapsedMs || 0) / 1000)
      status.textContent = 'elapsed: ' + secs + 's / step: ' + (s.currentStep || 0) + ' of ' + (s.totalSteps || 0)
      status.style.display = 'block'
    } else {
      status.style.display = 'none'
    }
    if (s.state === 'finished') {
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
