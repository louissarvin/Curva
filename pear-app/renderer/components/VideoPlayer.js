// Curva VideoPlayer: HTML5 <video> element controlled by the P2P playhead.
//
// Two-way sync:
//   - Inbound: curva.onPlayheadUpdate -> apply state to the local <video>.
//   - Outbound: user gestures (play/pause/seek) -> curva.setPlayhead.
//
// Loop prevention: applying an inbound state flips a suppressor flag so the
// resulting 'play'/'pause'/'seeked' DOM events don't bounce back over IPC.
//
// Drift correction: if abs(currentTime*1000 - state.match_time_ms) > 2000 the
// component seeks to catch up.
//
// This component is vanilla ES module (ADR-001). Never uses innerHTML.

const DRIFT_THRESHOLD_MS = 2000
const DEBOUNCE_MS = 33 // ~30 fps ceiling on outbound emits

// Wave 6 T3: host emits a periodic anchor with its current match_time_ms so
// receivers can snap when they drift. 10s cadence is a compromise between
// bandwidth and drift correction latency. Anchors are only emitted while the
// video is actively playing.
const ANCHOR_INTERVAL_MS = 10_000

// Cup Final: floating minute badge. Auto-hides after 3 missed heartbeats
// (backend pulse cadence is 15s so 45s is the stale threshold). Anything
// longer risks the badge lying during a backend outage.
const MINUTE_STALE_MS = 45_000
const MINUTE_STALE_CHECK_MS = 46_000

export function mountVideoPlayer({
  container,
  curva,
  initialSource,
  isHost = false,
  matchId = null,
  liveMinuteOverlayEnabled = true
} = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva bridge is required')

  container.textContent = ''
  container.classList.add('curva-video')

  const wrap = document.createElement('div')
  wrap.className = 'curva-video__wrap'

  const video = document.createElement('video')
  video.className = 'curva-video__el'
  video.controls = true
  video.preload = 'metadata'
  video.playsInline = true
  wrap.appendChild(video)

  // -- Live match minute overlay --------------------------------------------
  // Floating badge, top-right of the video wrap. Populated by the enriched
  // `match.pulse` frames the backend emits every 15s during a live fixture.
  // Auto-hides when: the room has no matchId, the flag is off, the status is
  // unknown/null, or no update has arrived for MINUTE_STALE_MS.
  const minuteBadge = document.createElement('div')
  minuteBadge.className = 'curva-video__minute'
  minuteBadge.setAttribute('aria-live', 'polite')
  minuteBadge.setAttribute('aria-label', 'match minute')
  minuteBadge.hidden = true
  wrap.appendChild(minuteBadge)

  const controls = document.createElement('div')
  controls.className = 'curva-video__controls'

  const sourceRow = document.createElement('div')
  sourceRow.className = 'curva-video__source'
  const sourceLabel = document.createElement('label')
  sourceLabel.className = 'curva-video__source-label'
  sourceLabel.textContent = 'source url'
  const sourceInput = document.createElement('input')
  sourceInput.type = 'text'
  sourceInput.placeholder = 'assets/sample-clip.mp4'
  sourceInput.className = 'curva-video__source-input'
  const sourceBtn = document.createElement('button')
  sourceBtn.type = 'button'
  sourceBtn.textContent = 'load'
  sourceBtn.className = 'curva-video__source-btn'
  sourceRow.appendChild(sourceLabel)
  sourceRow.appendChild(sourceInput)
  sourceRow.appendChild(sourceBtn)

  const statusRow = document.createElement('div')
  statusRow.className = 'curva-video__status'
  const statusEl = document.createElement('span')
  statusEl.className = 'curva-video__status-text'
  statusEl.textContent = 'no source'
  const syncEl = document.createElement('span')
  syncEl.className = 'curva-video__sync'
  syncEl.textContent = ''
  statusRow.appendChild(statusEl)
  statusRow.appendChild(syncEl)

  controls.appendChild(sourceRow)
  controls.appendChild(statusRow)

  container.appendChild(wrap)
  container.appendChild(controls)

  // -- source management ----------------------------------------------------

  function setSource(url) {
    if (!url) {
      video.removeAttribute('src')
      statusEl.textContent = 'no source'
      return
    }
    video.src = url
    statusEl.textContent = 'source: ' + url
  }

  if (initialSource) {
    setSource(initialSource)
    sourceInput.value = initialSource
  }

  sourceBtn.addEventListener('click', () => {
    setSource(sourceInput.value.trim())
  })
  sourceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') setSource(sourceInput.value.trim())
  })

  // -- suppressor: prevent inbound-triggered DOM events from re-emitting -----

  let suppressCount = 0
  function suppress(fn) {
    suppressCount++
    try { fn() } finally {
      // clear on next microtask so the resulting DOM event fires within scope.
      queueMicrotask(() => { suppressCount = Math.max(0, suppressCount - 1) })
    }
  }

  // -- inbound: playhead:update ---------------------------------------------

  function applyState(state) {
    if (!state || typeof state !== 'object') return
    const targetSec = (state.match_time_ms || 0) / 1000
    const drift = Math.abs(video.currentTime - targetSec) * 1000
    if (state.type === 'seek' || drift > DRIFT_THRESHOLD_MS) {
      suppress(() => { video.currentTime = targetSec })
    }
    if (state.type === 'play') {
      if (video.paused) suppress(() => { video.play().catch(() => {}) })
    }
    if (state.type === 'pause') {
      if (!video.paused) suppress(() => { video.pause() })
    }
    if (state.type === 'rate') {
      if (typeof state.rate === 'number') {
        suppress(() => { video.playbackRate = state.rate })
      }
    }
    statusEl.textContent = `${state.type} @ ${targetSec.toFixed(2)}s (peer ${short(state.by_peer)})`
    // Sync indicator: green when within 300ms, yellow within 1000ms, red beyond.
    const label = drift < 300
      ? 'in sync'
      : drift < 1000
        ? `${Math.round(drift)}ms drift`
        : `${Math.round(drift)}ms drift`
    syncEl.textContent = label
    syncEl.classList.toggle('curva-video__sync--good', drift < 300)
    syncEl.classList.toggle('curva-video__sync--warn', drift >= 300 && drift < 1000)
    syncEl.classList.toggle('curva-video__sync--bad', drift >= 1000)
  }

  const offInbound = curva.onPlayheadUpdate((state) => applyState(state))

  // -- tactical freeze/unfreeze integration ----------------------------------
  // VideoPlayer handles the video-layer concerns (pause + dim) on freeze.
  // The canvas drawing layer is handled by TacticalOverlay mounted on wrap.
  // We keep a dim element here that is distinct from TacticalOverlay's dim so
  // each layer owns its own DOM.

  const offTacticalFreeze = typeof curva.onTacticalFreeze === 'function'
    ? curva.onTacticalFreeze((frame) => {
        const targetSec = (Number(frame && frame.videoTsMs) || 0) / 1000
        if (Number.isFinite(targetSec) && targetSec > 0) {
          if (Math.abs(video.currentTime - targetSec) > 0.05) {
            suppress(() => { video.currentTime = targetSec })
          }
        }
        if (!video.paused) suppress(() => { video.pause() })
      })
    : () => {}

  const offTacticalUnfreeze = typeof curva.onTacticalUnfreeze === 'function'
    ? curva.onTacticalUnfreeze(() => {
        // Host re-emits a play via the normal playhead path. Nothing needed here.
      })
    : () => {}

  // -- outbound: user gestures -> setPlayhead --------------------------------

  let lastEmit = 0
  function emit(type, extras) {
    if (suppressCount > 0) return
    const now = performance.now()
    if (now - lastEmit < DEBOUNCE_MS && type !== 'seek') return
    lastEmit = now
    const matchTimeMs = Math.floor(video.currentTime * 1000)
    curva.setPlayhead(type, matchTimeMs, extras).catch((err) => {
      console.warn('[curva] setPlayhead failed:', err?.message)
    })
  }

  video.addEventListener('play', () => emit('play'))
  video.addEventListener('pause', () => emit('pause'))
  video.addEventListener('seeked', () => emit('seek'))
  video.addEventListener('ratechange', () => emit('rate', { rate: video.playbackRate }))

  // T3: host-only anchor emitter. Every ANCHOR_INTERVAL_MS while the video is
  // actively playing, publish { type:'seek', is_anchor:true, match_time_ms:... }
  // The worker downgrades non-host anchors, so a leak of the isHost flag here
  // has no security impact.
  let anchorTimer = null
  if (isHost) {
    anchorTimer = setInterval(() => {
      if (video.paused || video.ended) return
      if (!Number.isFinite(video.currentTime)) return
      const matchTimeMs = Math.floor(video.currentTime * 1000)
      if (matchTimeMs < 0) return
      curva.setPlayhead('seek', matchTimeMs, { is_anchor: true }).catch(() => { /* noop */ })
    }, ANCHOR_INTERVAL_MS)
  }

  // Host-only dev freeze button. Visible only when CURVA_TACTICAL_ENABLED is
  // truthy (checked by the caller after mounting TacticalOverlay). The button
  // is exposed via the returned handle; app.js or RoomHeader wires it up.
  let tacticalOverlay = null

  function attachTacticalOverlay(overlay) {
    tacticalOverlay = overlay
  }

  // -- Live minute overlay state machine ------------------------------------
  // Rules (see memory/impl_live_minute_overlay.md, docs verified 2026-07-06):
  //   IN_PLAY / LIVE, min 45 or 90, injuryTime > 0   -> "45+3'"
  //   IN_PLAY / LIVE, any other minute                -> "34'"
  //   PAUSED                                          -> "HT"
  //   EXTRA_TIME                                      -> "105' ET"
  //   PENALTY_SHOOTOUT                                -> "PSO"
  //   FINISHED / AWARDED                              -> "FT"
  //   any other status / null minute                  -> hidden
  function formatMinute(p) {
    if (!p || typeof p !== 'object') return ''
    const s = p.status
    if (s === 'PAUSED') return 'HT'
    if (s === 'FINISHED' || s === 'AWARDED') return 'FT'
    if (s === 'PENALTY_SHOOTOUT') return 'PSO'
    if (s !== 'IN_PLAY' && s !== 'LIVE' && s !== 'EXTRA_TIME') return ''
    const min = Number.isFinite(p.minute) ? p.minute : null
    if (min === null) return ''
    const injury = Number.isFinite(p.injuryTime) && p.injuryTime > 0 ? p.injuryTime : null
    const etTag = s === 'EXTRA_TIME' ? ' ET' : ''
    // injuryTime is a half-end marker in football-data v4, not a running count.
    // Only append at the boundary minutes to avoid rendering "44+3'" nonsense.
    if (injury && (min === 45 || min === 90 || min === 105 || min === 120)) {
      return `${min}+${injury}'${etTag}`
    }
    return `${min}'${etTag}`
  }

  let minuteLastAt = 0
  let minuteStaleTimer = null
  function hideMinute() {
    minuteBadge.hidden = true
    minuteBadge.textContent = ''
  }
  function applyMinutePulse(p) {
    // Guard: only render when the room is tied to a real match. Backend keys
    // pulses by matchId; a foreign matchId is an obvious drop.
    if (!matchId || !p || typeof p !== 'object') return
    if (typeof p.matchId === 'string' && p.matchId !== matchId) return
    const text = formatMinute(p)
    if (!text) {
      hideMinute()
      return
    }
    minuteBadge.textContent = text
    minuteBadge.hidden = false
    minuteLastAt = Date.now()
    if (minuteStaleTimer) clearTimeout(minuteStaleTimer)
    minuteStaleTimer = setTimeout(() => {
      if (Date.now() - minuteLastAt >= MINUTE_STALE_MS) hideMinute()
    }, MINUTE_STALE_CHECK_MS)
  }

  const overlayActive = !!(liveMinuteOverlayEnabled && matchId && typeof curva.onMatchMinute === 'function')
  const offMinute = overlayActive
    ? curva.onMatchMinute((p) => applyMinutePulse(p))
    : () => {}

  function destroy() {
    if (anchorTimer) { clearInterval(anchorTimer); anchorTimer = null }
    if (minuteStaleTimer) { clearTimeout(minuteStaleTimer); minuteStaleTimer = null }
    offInbound()
    offTacticalFreeze()
    offTacticalUnfreeze()
    try { offMinute() } catch { /* noop */ }
    try { video.pause() } catch { /* noop */ }
    container.textContent = ''
  }

  return { destroy, video, setSource, wrap, attachTacticalOverlay }
}

function short(hex) {
  if (typeof hex !== 'string') return String(hex)
  return hex.length > 12 ? hex.slice(0, 8) : hex
}
