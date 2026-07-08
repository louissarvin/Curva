// Curva ClipGallery: capture last 10s + shared clip grid.
// Vanilla ES module (ADR-001). textContent only, never innerHTML.
//
// Two responsibilities:
//   1. "Clip last 10s" button: uses MediaRecorder on the video element's
//      captureStream. On unsupported browsers or CORS-blocked video sources we
//      fall back to a "metadata-only" clip (records the timestamp, no bytes).
//   2. Grid of shared clips: fetches via curva.listClips, subscribes to
//      curva.onClipAdded, and plays clips in a modal on click.

const CLIP_LEN_MS = 10_000

export function mountClipGallery({ container, curva, videoPlayer } = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva bridge is required')

  container.textContent = ''
  container.classList.add('curva-clips')

  // -- header ----------------------------------------------------------------

  const header = document.createElement('div')
  header.className = 'curva-clips__header'

  const title = document.createElement('span')
  title.className = 'curva-clips__title'
  title.textContent = 'clips'

  const count = document.createElement('span')
  count.className = 'curva-clips__count'
  count.textContent = '0 clips'

  header.appendChild(title)
  header.appendChild(count)

  // -- capture bar -----------------------------------------------------------

  const captureBar = document.createElement('div')
  captureBar.className = 'curva-clips__capture'

  const captureBtn = document.createElement('button')
  captureBtn.type = 'button'
  captureBtn.className = 'curva-clips__capture-btn'
  captureBtn.textContent = 'Clip last 10s'

  const captionInput = document.createElement('input')
  captionInput.type = 'text'
  captionInput.className = 'curva-clips__caption'
  captionInput.placeholder = 'caption (optional)'
  captionInput.maxLength = 200

  const captureStatus = document.createElement('span')
  captureStatus.className = 'curva-clips__capture-status'
  captureStatus.textContent = ''

  captureBar.appendChild(captureBtn)
  captureBar.appendChild(captionInput)
  captureBar.appendChild(captureStatus)

  // -- grid + modal ----------------------------------------------------------

  const grid = document.createElement('ul')
  grid.className = 'curva-clips__grid'

  const emptyState = document.createElement('div')
  emptyState.className = 'curva-clips__empty'
  emptyState.textContent = 'no clips yet. hit "Clip last 10s" during a goal.'

  container.appendChild(header)
  container.appendChild(captureBar)
  container.appendChild(grid)
  container.appendChild(emptyState)

  // Modal for clip playback. Hidden by default.
  const modal = document.createElement('div')
  modal.className = 'curva-clips__modal'
  modal.hidden = true

  const modalBackdrop = document.createElement('div')
  modalBackdrop.className = 'curva-clips__modal-backdrop'

  const modalCard = document.createElement('div')
  modalCard.className = 'curva-clips__modal-card'

  const modalClose = document.createElement('button')
  modalClose.type = 'button'
  modalClose.className = 'curva-clips__modal-close'
  modalClose.textContent = 'close'

  const modalVideo = document.createElement('video')
  modalVideo.className = 'curva-clips__modal-video'
  modalVideo.controls = true
  modalVideo.autoplay = true

  const modalMeta = document.createElement('div')
  modalMeta.className = 'curva-clips__modal-meta'

  modalCard.appendChild(modalClose)
  modalCard.appendChild(modalVideo)
  modalCard.appendChild(modalMeta)
  modal.appendChild(modalBackdrop)
  modal.appendChild(modalCard)
  container.appendChild(modal)

  function closeModal() {
    modal.hidden = true
    try { modalVideo.pause() } catch { /* noop */ }
    if (modalVideo.src?.startsWith('blob:')) {
      try { URL.revokeObjectURL(modalVideo.src) } catch { /* noop */ }
    }
    // For HTTP blob-server URLs: just remove src, the browser stops the request.
    modalVideo.removeAttribute('src')
  }
  modalClose.addEventListener('click', closeModal)
  modalBackdrop.addEventListener('click', closeModal)

  // Close on ESC key. Listener is on the document and cleaned up in destroy().
  function onKeyDown(ev) {
    if (ev.key === 'Escape' && !modal.hidden) closeModal()
  }
  document.addEventListener('keydown', onKeyDown)

  // -- state -----------------------------------------------------------------

  const clipsByKey = new Map() // clipId -> row li

  function keyForClip(clip) {
    return clip.clipId || `${clip.ts}`
  }

  function renderEmptyState() {
    emptyState.hidden = clipsByKey.size > 0
  }

  function addRow(clip) {
    const k = keyForClip(clip)
    if (clipsByKey.has(k)) return
    const li = document.createElement('li')
    li.className = 'curva-clips__row'
    li.dataset.driveKey = clip.driveKey
    li.dataset.path = clip.path
    if (clip?.thumb?.coreKey) li.dataset.thumbCoreKey = clip.thumb.coreKey
    if (clip?.thumb?.mimeType) li.dataset.thumbMime = clip.thumb.mimeType

    const thumb = document.createElement('div')
    thumb.className = 'curva-clips__thumb'
    thumb.textContent = 'CLIP'
    // Task 7: async request thumb bytes if available. On success, replace
    // the "CLIP" placeholder with an <img> using an object URL. Rejects
    // silently — thumbnails are best-effort visual polish.
    if (clip?.thumb?.coreKey && clip?.thumb?.blobId && typeof curva.getClipThumb === 'function') {
      curva.getClipThumb(clip.thumb.coreKey, clip.thumb.blobId).catch(() => { /* noop */ })
    }

    const meta = document.createElement('div')
    meta.className = 'curva-clips__meta'

    const titleRow = document.createElement('div')
    titleRow.className = 'curva-clips__caption-line'
    titleRow.textContent = clip.caption || '(no caption)'

    const timeRow = document.createElement('div')
    timeRow.className = 'curva-clips__time-line'
    timeRow.textContent = `match ${formatMatchTime(clip.match_time_ms)} • by ${shortPeer(clip.by_peer)}`

    meta.appendChild(titleRow)
    meta.appendChild(timeRow)

    li.appendChild(thumb)
    li.appendChild(meta)

    li.addEventListener('click', () => playClip(clip))

    grid.appendChild(li)
    clipsByKey.set(k, li)
    count.textContent = clipsByKey.size + ' clip' + (clipsByKey.size === 1 ? '' : 's')
    renderEmptyState()
  }

  async function playClip(clip) {
    modal.hidden = false
    modalMeta.textContent = `loading clip from ${shortPeer(clip.by_peer)}...`

    // Preferred path: blob-server HTTP URL. Native byte-range seek, no IPC memory pressure.
    // Falls back to the legacy base64-over-IPC path when the blob server is unavailable.
    if (typeof curva.getClipLink === 'function') {
      let linkUnsubscribe = null
      let linkReject = null
      const linkPromise = new Promise((resolve, reject) => {
        linkReject = reject
        linkUnsubscribe = curva.onClipLink((payload) => {
          if (linkUnsubscribe) { linkUnsubscribe(); linkUnsubscribe = null }
          if (payload && payload.error) reject(new Error(payload.error))
          else resolve(payload)
        })
      })
      const abortTimer = setTimeout(() => {
        if (linkUnsubscribe) { linkUnsubscribe(); linkUnsubscribe = null }
        if (linkReject) { linkReject(new Error('blob-server link timed out')); linkReject = null }
      }, 8000)

      curva.getClipLink(clip.driveKey, clip.path).catch(() => {})

      linkPromise.then(({ url }) => {
        clearTimeout(abortTimer)
        if (modal.hidden) return
        // Validate URL scheme before assigning to video.src.
        // Only http://127.0.0.1:* is expected from the blob server.
        if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1(:\d+)?\//.test(url)) {
          modalMeta.textContent = 'invalid blob-server URL'
          return
        }
        modalVideo.src = url
        modalMeta.textContent = `driveKey ${clip.driveKey.slice(0, 8)}...`
      }).catch((err) => {
        clearTimeout(abortTimer)
        // Fall through to legacy IPC path.
        modalMeta.textContent = 'blob-server unavailable, falling back...'
        curva.getClip(clip.driveKey, clip.path, clip.by_peer).catch((e) => {
          modalMeta.textContent = 'failed to load: ' + (e?.message || 'unknown')
        })
      })
      return
    }

    // Legacy fallback: full buffer over IPC.
    curva.getClip(clip.driveKey, clip.path, clip.by_peer).catch((err) => {
      modalMeta.textContent = 'failed to load: ' + (err?.message || 'unknown')
    })
  }

  const offClipData = curva.onClipData(({ driveKey, path, buffer }) => {
    if (modal.hidden) return
    // Only load if this response matches the open modal target.
    const li = [...clipsByKey.values()].find((row) => row.dataset.driveKey === driveKey && row.dataset.path === path)
    if (!li) return
    const arrBuf = curva.decodeClipBuffer(buffer)
    const blob = new Blob([arrBuf], { type: 'video/mp4' })
    const url = URL.createObjectURL(blob)
    modalVideo.src = url
    modalMeta.textContent = `driveKey ${driveKey.slice(0, 8)}... • ${path}`
  })

  const offClipThumb = typeof curva.onClipThumb === 'function'
    ? curva.onClipThumb(({ coreKey, buffer }) => {
        if (!coreKey || !buffer) return
        const row = [...clipsByKey.values()].find((li) => li.dataset.thumbCoreKey === coreKey)
        if (!row) return
        const thumbEl = row.querySelector('.curva-clips__thumb')
        if (!thumbEl) return
        try {
          const arrBuf = curva.decodeClipBuffer(buffer)
          // Use the mimeType captured on the clip index entry. Real ffmpeg
          // thumbnails are image/jpeg (128x72). If ffmpeg was unavailable or
          // disabled at capture time, the entry stores an octet-stream
          // placeholder (first 8 KiB of the clip) which the browser will
          // refuse to render — the img.error handler below reverts to text.
          const mime = row.dataset.thumbMime || 'application/octet-stream'
          const blob = new Blob([arrBuf], { type: mime })
          const url = URL.createObjectURL(blob)
          thumbEl.textContent = ''
          const img = document.createElement('img')
          img.className = 'curva-clips__thumb-img'
          img.alt = 'clip thumbnail'
          img.src = url
          img.addEventListener('error', () => {
            try { URL.revokeObjectURL(url) } catch { /* noop */ }
            // Fallback: revert to the plain 'CLIP' text.
            thumbEl.textContent = 'CLIP'
          })
          thumbEl.appendChild(img)
        } catch { /* noop */ }
      })
    : () => {}

  const offClipError = curva.onClipError(({ code, message }) => {
    captureStatus.textContent = `error [${code}]: ${message}`
    captureStatus.classList.add('curva-clips__capture-status--err')
    setTimeout(() => {
      captureStatus.textContent = ''
      captureStatus.classList.remove('curva-clips__capture-status--err')
    }, 6000)
  })

  // -- subscriptions ---------------------------------------------------------

  const offClipAdded = curva.onClipAdded((clip) => {
    addRow(clip)
  })

  const offClipList = curva.onClipList(({ clips }) => {
    if (!Array.isArray(clips)) return
    for (const clip of clips) addRow(clip)
  })

  // Prime with existing list.
  curva.listClips({}).catch(() => { /* noop */ })

  // -- capture (MediaRecorder) ----------------------------------------------

  captureBtn.addEventListener('click', async () => {
    captureBtn.disabled = true
    captureStatus.textContent = 'recording 10s...'
    captureStatus.classList.remove('curva-clips__capture-status--err')

    const caption = captionInput.value.trim().slice(0, 200) || undefined
    const matchTimeMs = videoPlayer?.video ? Math.floor(videoPlayer.video.currentTime * 1000) : 0

    let recordedBlob = null
    try {
      recordedBlob = await recordVideoLastNMs(videoPlayer?.video, CLIP_LEN_MS)
    } catch (err) {
      captureStatus.textContent = 'record failed: ' + (err?.message || err)
      captureStatus.classList.add('curva-clips__capture-status--err')
      captureBtn.disabled = false
      return
    }

    if (!recordedBlob || recordedBlob.size === 0) {
      // Metadata-only fallback: send a 1-byte marker with the timestamp so
      // peers still see a clip entry.
      captureStatus.textContent = 'MediaRecorder unavailable; saved metadata only'
      const marker = new Uint8Array([0x43, 0x55, 0x52, 0x56, 0x41]) // 'CURVA'
      try {
        await curva.addClip(marker.buffer, matchTimeMs, caption ? '(meta) ' + caption : '(meta)')
      } catch (err) {
        captureStatus.textContent = 'metadata clip failed: ' + err.message
        captureStatus.classList.add('curva-clips__capture-status--err')
      }
      captureBtn.disabled = false
      captionInput.value = ''
      return
    }

    try {
      const arr = await recordedBlob.arrayBuffer()
      await curva.addClip(arr, matchTimeMs, caption)
      captureStatus.textContent = 'clip added (' + Math.round(recordedBlob.size / 1024) + ' KiB)'
      captionInput.value = ''
    } catch (err) {
      captureStatus.textContent = 'save failed: ' + (err?.message || err)
      captureStatus.classList.add('curva-clips__capture-status--err')
    } finally {
      captureBtn.disabled = false
    }
  })

  function destroy() {
    document.removeEventListener('keydown', onKeyDown)
    offClipAdded()
    offClipList()
    offClipData()
    offClipError()
    offClipThumb()
    closeModal()
    container.textContent = ''
  }

  return { destroy }
}

// -- helpers ---------------------------------------------------------------

function shortPeer(hex) {
  if (typeof hex !== 'string') return '(unknown)'
  return hex.length > 8 ? hex.slice(0, 8) : hex
}

function formatMatchTime(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '--:--'
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Try to record `ms` milliseconds from a video element via MediaRecorder.
// Returns Blob on success, or null if MediaRecorder / captureStream unavailable.
async function recordVideoLastNMs(video, ms) {
  if (!video) return null
  if (typeof MediaRecorder !== 'function') return null
  if (typeof video.captureStream !== 'function') return null

  let stream
  try {
    stream = video.captureStream()
  } catch {
    return null
  }
  if (!stream || stream.getTracks().length === 0) return null

  // Pick a mime type the browser supports.
  const mimeCandidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ]
  let mimeType = ''
  for (const m of mimeCandidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) {
      mimeType = m
      break
    }
  }
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream)
  const chunks = []
  recorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  })

  const stopped = new Promise((resolve) => {
    recorder.addEventListener('stop', () => resolve())
  })

  recorder.start()
  await new Promise((r) => setTimeout(r, ms))
  try { recorder.stop() } catch { /* noop */ }
  await stopped

  return new Blob(chunks, { type: mimeType || 'video/webm' })
}
