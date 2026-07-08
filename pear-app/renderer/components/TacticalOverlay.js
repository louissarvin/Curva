// Curva TacticalOverlay: absolute-positioned canvas layered on top of VideoPlayer.
//
// Inactive by default (pointer-events: none). When the host emits tactical:freeze
// the overlay activates: pointer events go to canvas, strokes are captured,
// debounced to ~60Hz, and broadcast via curva.tacticalSendStroke.
//
// On receiving tactical:stroke events from peers, strokes render via rAF.
// Canvas is cleared on tactical:unfreeze.
//
// Coordinate space: all points are normalized [0..1] relative to the video element
// dimensions. This survives aspect-ratio differences between peers.
//
// Vanilla ES module (ADR-001). No innerHTML anywhere.

const STROKE_BROADCAST_HZ = 60
const STROKE_INTERVAL_MS = 1000 / STROKE_BROADCAST_HZ

/**
 * Mount a tactical drawing overlay onto the video container.
 *
 * @param {{
 *   container: HTMLElement,   the video wrap div (position:relative parent)
 *   videoEl: HTMLVideoElement,
 *   curva: object,            the curva bridge
 *   isHost: boolean
 * }} opts
 *
 * @returns {{
 *   destroy: () => void,
 *   freezeAt: (videoTsMs: number) => void,   host only
 *   unfreezeAt: (videoTsMs: number) => void, host only
 *   get frozen(): boolean
 * }}
 */
export function mountTacticalOverlay({ container, videoEl, curva, isHost = false } = {}) {
  if (!container) throw new TypeError('container required')
  if (!videoEl) throw new TypeError('videoEl required')
  if (!curva) throw new TypeError('curva bridge required')

  // Ensure the container establishes a positioning context.
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative'
  }

  const canvas = document.createElement('canvas')
  canvas.className = 'curva-tactical__canvas'
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.pointerEvents = 'none'
  canvas.style.background = 'transparent'
  canvas.style.zIndex = '10'
  container.appendChild(canvas)

  const ctx = canvas.getContext('2d')

  // Map of strokeId -> { kind, points, color, widthPx }. Cleared on unfreeze.
  const strokes = new Map()
  let frozen = false

  // -- Resize observer: keep canvas pixel dimensions aligned with videoEl ------
  function resize() {
    const rect = videoEl.getBoundingClientRect()
    const w = Math.max(1, Math.floor(rect.width * devicePixelRatio))
    const h = Math.max(1, Math.floor(rect.height * devicePixelRatio))
    canvas.width = w
    canvas.height = h
    canvas.style.width = rect.width + 'px'
    canvas.style.height = rect.height + 'px'
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
    render()
  }

  const ro = new ResizeObserver(resize)
  ro.observe(videoEl)
  resize()

  // -- Render all stored strokes ------------------------------------------------
  function render() {
    const w = canvas.width / devicePixelRatio
    const h = canvas.height / devicePixelRatio
    ctx.clearRect(0, 0, w, h)
    if (!frozen) return

    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const s of strokes.values()) {
      if (!s.points || s.points.length < 2) continue
      ctx.strokeStyle = s.color || '#ffdb4d'
      ctx.lineWidth = s.widthPx || 3
      ctx.beginPath()
      const [x0, y0] = s.points[0]
      ctx.moveTo(x0 * w, y0 * h)

      if (s.kind === 'freehand') {
        for (let i = 1; i < s.points.length; i++) {
          const [xi, yi] = s.points[i]
          ctx.lineTo(xi * w, yi * h)
        }
      } else {
        // 'line' or 'arrow': connect first to last only.
        const [xN, yN] = s.points[s.points.length - 1]
        ctx.lineTo(xN * w, yN * h)
        if (s.kind === 'arrow') {
          drawArrowHead(ctx, x0 * w, y0 * h, xN * w, yN * h, s.widthPx || 3)
        }
      }
      ctx.stroke()
    }
    ctx.restore()
  }

  // -- Dim overlay (added to container when frozen) ---------------------------
  const dimEl = document.createElement('div')
  dimEl.className = 'curva-tactical__dim'
  dimEl.style.position = 'absolute'
  dimEl.style.inset = '0'
  dimEl.style.background = 'rgba(0,0,0,0.30)'
  dimEl.style.pointerEvents = 'none'
  dimEl.style.opacity = '0'
  dimEl.style.transition = 'opacity 120ms ease'
  dimEl.style.zIndex = '9'
  container.appendChild(dimEl)

  // -- Freeze / unfreeze helpers -----------------------------------------------
  function applyFreeze() {
    frozen = true
    strokes.clear()
    canvas.style.pointerEvents = 'auto'
    dimEl.style.opacity = '1'
    container.classList.add('curva-tactical--frozen')
    render()
  }

  function applyUnfreeze() {
    frozen = false
    strokes.clear()
    canvas.style.pointerEvents = 'none'
    dimEl.style.opacity = '0'
    container.classList.remove('curva-tactical--frozen')
    render()
  }

  // -- Inbound events ----------------------------------------------------------
  const offFreeze = curva.onTacticalFreeze((frame) => {
    applyFreeze()
    // Snap video to the freeze timestamp so every peer sees the same frame.
    const targetSec = (Number(frame && frame.videoTsMs) || 0) / 1000
    if (Number.isFinite(targetSec) && targetSec > 0) {
      if (Math.abs(videoEl.currentTime - targetSec) > 0.05) {
        videoEl.currentTime = targetSec
      }
    }
    if (!videoEl.paused) {
      videoEl.pause()
    }
  })

  const offUnfreeze = curva.onTacticalUnfreeze(() => {
    applyUnfreeze()
    // VideoPlayer resumes playhead sync via its own onTacticalUnfreeze subscription.
  })

  const offStroke = curva.onTacticalStroke((msg) => {
    if (!frozen || !msg || !msg.strokeId) return
    strokes.set(msg.strokeId, {
      kind: msg.kind || 'freehand',
      points: Array.isArray(msg.points) ? msg.points : [],
      color: typeof msg.color === 'string' ? msg.color : '#ffdb4d',
      widthPx: typeof msg.widthPx === 'number' ? msg.widthPx : 3
    })
    requestAnimationFrame(render)
  })

  // -- Outbound: local drawing -------------------------------------------------
  let activeStroke = null
  let lastBroadcastAt = 0

  function toNorm(clientX, clientY) {
    const rect = canvas.getBoundingClientRect()
    return [
      Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    ]
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (!frozen) return
    canvas.setPointerCapture(ev.pointerId)
    activeStroke = {
      strokeId: cryptoRandomId(),
      kind: 'freehand',
      points: [toNorm(ev.clientX, ev.clientY)],
      color: '#ffdb4d',
      widthPx: 3,
      ts: Date.now()
    }
    strokes.set(activeStroke.strokeId, activeStroke)
    lastBroadcastAt = 0
    requestAnimationFrame(render)
  })

  canvas.addEventListener('pointermove', (ev) => {
    if (!activeStroke || !frozen) return
    activeStroke.points.push(toNorm(ev.clientX, ev.clientY))
    requestAnimationFrame(render)
    const now = performance.now()
    if (now - lastBroadcastAt >= STROKE_INTERVAL_MS) {
      lastBroadcastAt = now
      const payload = {
        strokeId: activeStroke.strokeId,
        kind: activeStroke.kind,
        points: activeStroke.points.slice(),
        color: activeStroke.color,
        widthPx: activeStroke.widthPx,
        timestampMs: activeStroke.ts
      }
      if (typeof curva.tacticalSendStroke === 'function') {
        Promise.resolve(curva.tacticalSendStroke(payload)).catch(() => {})
      }
    }
  })

  function endStroke() {
    if (!activeStroke) return
    const payload = {
      strokeId: activeStroke.strokeId,
      kind: activeStroke.kind,
      points: activeStroke.points.slice(),
      color: activeStroke.color,
      widthPx: activeStroke.widthPx,
      timestampMs: activeStroke.ts
    }
    if (typeof curva.tacticalSendStroke === 'function') {
      Promise.resolve(curva.tacticalSendStroke(payload)).catch(() => {})
    }
    activeStroke = null
  }

  canvas.addEventListener('pointerup', endStroke)
  canvas.addEventListener('pointercancel', endStroke)

  // -- Host-only controls ------------------------------------------------------
  // These are called by the freeze/unfreeze buttons rendered by the caller.
  // Non-host calls are silently ignored.
  function freezeAt(videoTsMs) {
    if (!isHost) return
    // Apply locally immediately so the host UI responds without waiting for the
    // IPC round-trip echo.
    applyFreeze()
    if (!videoEl.paused) videoEl.pause()
    if (typeof curva.tacticalSendFreeze === 'function') {
      Promise.resolve(curva.tacticalSendFreeze({ videoTsMs })).catch(() => {})
    }
  }

  function unfreezeAt(videoTsMs) {
    if (!isHost) return
    applyUnfreeze()
    if (typeof curva.tacticalSendUnfreeze === 'function') {
      Promise.resolve(curva.tacticalSendUnfreeze({ videoTsMs })).catch(() => {})
    }
  }

  // -- Cleanup -----------------------------------------------------------------
  function destroy() {
    offFreeze()
    offUnfreeze()
    offStroke()
    ro.disconnect()
    canvas.remove()
    dimEl.remove()
    container.classList.remove('curva-tactical--frozen')
  }

  return {
    destroy,
    freezeAt,
    unfreezeAt,
    get frozen() { return frozen }
  }
}

// -- Helpers -----------------------------------------------------------------

function drawArrowHead(ctx, x0, y0, x1, y1, w) {
  const angle = Math.atan2(y1 - y0, x1 - x0)
  const size = Math.max(8, w * 3)
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(
    x1 - size * Math.cos(angle - Math.PI / 6),
    y1 - size * Math.sin(angle - Math.PI / 6)
  )
  ctx.moveTo(x1, y1)
  ctx.lineTo(
    x1 - size * Math.cos(angle + Math.PI / 6),
    y1 - size * Math.sin(angle + Math.PI / 6)
  )
  ctx.stroke()
}

function cryptoRandomId() {
  const buf = new Uint8Array(8)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}
