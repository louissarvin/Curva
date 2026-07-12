// Curva FrameAnalyzePanel: appears while the video is paused. Two actions:
//   1. "Describe frame" -> curva.vlm.caption(frame)   (SmolVLM2 500M Q8_0)
//   2. "Read text"      -> curva.ocr.read(frame)      (OCR_LATIN)
//
// Both results are (a) shown in the panel and (b) posted back to chat as a
// system message via `onSystemMessage` so peers see the caption / OCR blocks
// over Autobase.
//
// Security posture (frontend XSS defense):
//   - Only textContent is written. Never innerHTML.
//   - The bridge (`curva.vlm.caption` / `curva.ocr.read`) is expected to
//     return already-sanitized text (see bare/vlmCaption.js sanitizeCaption
//     and bare/ocr.js sanitizeText). We defense-in-depth by also writing via
//     textContent here.
//   - The bridge functions are optional: the panel gracefully hides its
//     buttons when the coordinator hasn't wired them yet.

const MAX_BLOCK_ROWS = 32   // matches bare/ocr.js cap

/**
 * @param {{
 *   container: HTMLElement,
 *   curva: {
 *     vlm?: { caption: (frame: string|Blob|ArrayBuffer, opts?: object) => Promise<{ok:boolean, caption?:string, code?:string, reason?:string}> },
 *     ocr?: { read: (frame: string|Blob|ArrayBuffer, opts?: object) => Promise<{ok:boolean, blocks?: Array<{text:string, bbox?:number[], confidence?:number}>, code?:string, reason?:string}> }
 *   },
 *   getFrame: () => (string | Blob | ArrayBuffer | null),
 *   onSystemMessage?: (text: string, source: 'vlm'|'ocr') => void,
 *   labels?: { title?: string, describe?: string, read?: string, pausedHint?: string, busy?: string }
 * }} opts
 */
export function mountFrameAnalyzePanel ({
  container,
  curva,
  getFrame,
  onSystemMessage,
  labels = {}
} = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva bridge is required')
  if (typeof getFrame !== 'function') throw new TypeError('getFrame() is required')

  const L = Object.freeze({
    title: labels.title || 'Frame analysis',
    describe: labels.describe || 'Describe frame',
    read: labels.read || 'Read text',
    pausedHint: labels.pausedHint || 'Pause the video, then analyse the current frame.',
    busy: labels.busy || 'Analysing...'
  })

  container.textContent = ''
  container.classList.add('curva-frame-analyze')

  const header = document.createElement('div')
  header.className = 'curva-frame-analyze__header'
  header.textContent = L.title
  container.appendChild(header)

  const hint = document.createElement('div')
  hint.className = 'curva-frame-analyze__hint'
  hint.textContent = L.pausedHint
  container.appendChild(hint)

  const btnRow = document.createElement('div')
  btnRow.className = 'curva-frame-analyze__buttons'

  const btnDescribe = document.createElement('button')
  btnDescribe.type = 'button'
  btnDescribe.className = 'curva-frame-analyze__btn curva-frame-analyze__btn--describe'
  btnDescribe.textContent = L.describe
  btnDescribe.disabled = true
  btnRow.appendChild(btnDescribe)

  const btnOcr = document.createElement('button')
  btnOcr.type = 'button'
  btnOcr.className = 'curva-frame-analyze__btn curva-frame-analyze__btn--ocr'
  btnOcr.textContent = L.read
  btnOcr.disabled = true
  btnRow.appendChild(btnOcr)

  container.appendChild(btnRow)

  const status = document.createElement('div')
  status.className = 'curva-frame-analyze__status'
  status.setAttribute('aria-live', 'polite')
  status.hidden = true
  container.appendChild(status)

  const captionOut = document.createElement('div')
  captionOut.className = 'curva-frame-analyze__caption'
  captionOut.hidden = true
  container.appendChild(captionOut)

  const blocksOut = document.createElement('ul')
  blocksOut.className = 'curva-frame-analyze__blocks'
  blocksOut.hidden = true
  container.appendChild(blocksOut)

  // Bridge presence checks. If a feature is missing (coordinator not wired
  // yet, or user opted out of the model), the button stays hidden so the UI
  // never advertises something we can't deliver.
  const hasVlm = !!(curva.vlm && typeof curva.vlm.caption === 'function')
  const hasOcr = !!(curva.ocr && typeof curva.ocr.read === 'function')
  if (!hasVlm) btnDescribe.hidden = true
  if (!hasOcr) btnOcr.hidden = true

  let paused = false
  let busy = false

  function setPaused (nextPaused) {
    paused = !!nextPaused
    updateButtons()
    if (!paused) clearOutputs()
  }

  function updateButtons () {
    btnDescribe.disabled = !(paused && !busy && hasVlm)
    btnOcr.disabled = !(paused && !busy && hasOcr)
  }

  function clearOutputs () {
    status.hidden = true
    status.textContent = ''
    captionOut.hidden = true
    captionOut.textContent = ''
    blocksOut.hidden = true
    blocksOut.textContent = ''
  }

  function setBusy (nextBusy, msg) {
    busy = !!nextBusy
    if (busy) {
      status.hidden = false
      status.textContent = msg || L.busy
    } else if (!msg) {
      status.hidden = true
      status.textContent = ''
    } else {
      status.hidden = false
      status.textContent = msg
    }
    updateButtons()
  }

  function renderCaption (text) {
    // XSS-safe: textContent only. Also cap the visible length as defense in
    // depth on top of the bare/vlmCaption.js sanitizer.
    const safe = String(text || '').slice(0, 2000)
    captionOut.textContent = safe
    captionOut.hidden = false
  }

  function renderBlocks (blocks) {
    blocksOut.textContent = ''
    if (!Array.isArray(blocks) || blocks.length === 0) {
      blocksOut.hidden = true
      return
    }
    const capped = blocks.slice(0, MAX_BLOCK_ROWS)
    for (const b of capped) {
      const li = document.createElement('li')
      li.className = 'curva-frame-analyze__block'

      const txt = document.createElement('span')
      txt.className = 'curva-frame-analyze__block-text'
      txt.textContent = String(b.text || '').slice(0, 256)
      li.appendChild(txt)

      if (typeof b.confidence === 'number' && Number.isFinite(b.confidence)) {
        const c = document.createElement('span')
        c.className = 'curva-frame-analyze__block-conf'
        c.textContent = ` (${Math.round(b.confidence * 100)}%)`
        li.appendChild(c)
      }
      blocksOut.appendChild(li)
    }
    blocksOut.hidden = false
  }

  async function runDescribe () {
    if (!hasVlm || busy || !paused) return
    const frame = getFrame()
    if (frame == null) {
      setBusy(false, 'Frame unavailable')
      return
    }
    clearOutputs()
    setBusy(true)
    try {
      const res = await curva.vlm.caption(frame)
      if (res && res.ok && typeof res.caption === 'string' && res.caption) {
        renderCaption(res.caption)
        if (typeof onSystemMessage === 'function') {
          try { onSystemMessage(res.caption, 'vlm') } catch { /* noop */ }
        }
        setBusy(false)
      } else {
        setBusy(false, `Describe failed: ${(res && (res.reason || res.code)) || 'unknown error'}`)
      }
    } catch (err) {
      setBusy(false, `Describe failed: ${err?.message || 'unknown error'}`)
    }
  }

  async function runRead () {
    if (!hasOcr || busy || !paused) return
    const frame = getFrame()
    if (frame == null) {
      setBusy(false, 'Frame unavailable')
      return
    }
    clearOutputs()
    setBusy(true)
    try {
      const res = await curva.ocr.read(frame)
      if (res && res.ok && Array.isArray(res.blocks)) {
        renderBlocks(res.blocks)
        if (res.blocks.length === 0) {
          setBusy(false, 'No text detected')
        } else {
          setBusy(false)
          if (typeof onSystemMessage === 'function') {
            const summary = res.blocks
              .map((b) => b.text)
              .filter(Boolean)
              .slice(0, 8)
              .join(' | ')
              .slice(0, 256)
            if (summary) {
              try { onSystemMessage(summary, 'ocr') } catch { /* noop */ }
            }
          }
        }
      } else {
        setBusy(false, `Read failed: ${(res && (res.reason || res.code)) || 'unknown error'}`)
      }
    } catch (err) {
      setBusy(false, `Read failed: ${err?.message || 'unknown error'}`)
    }
  }

  btnDescribe.addEventListener('click', () => { runDescribe() })
  btnOcr.addEventListener('click', () => { runRead() })

  // Live progress hookup: on first-load, SmolVLM2 500MB and the OCR pair
  // (LATIN 15MB + CRAFT 84MB) can take minutes to download. Without progress
  // feedback the user stares at "Analysing..." for 4 min and reasonably
  // concludes the app is broken. Subscribe to the QVAC model progress events
  // and reflect them in the status line.
  const unsubs = []
  function subscribeProgress (subscribeFn, label) {
    if (typeof subscribeFn !== 'function') return
    try {
      const off = subscribeFn((ev) => {
        if (!busy) return
        const pct = Number(ev?.p ?? ev?.percentage ?? ev?.percent ?? 0)
        if (pct > 0 && pct <= 100) {
          status.hidden = false
          status.textContent = `Loading ${label} model... ${Math.round(pct)}%`
        }
      })
      if (typeof off === 'function') unsubs.push(off)
    } catch { /* noop */ }
  }
  function subscribeLoading (subscribeFn, label) {
    if (typeof subscribeFn !== 'function') return
    try {
      const off = subscribeFn(() => {
        if (!busy) return
        status.hidden = false
        status.textContent = `Loading ${label} model...`
      })
      if (typeof off === 'function') unsubs.push(off)
    } catch { /* noop */ }
  }
  if (curva.vlm && curva.vlm.onProgress) subscribeProgress(curva.vlm.onProgress, 'vision')
  if (curva.vlm && curva.vlm.onLoading)  subscribeLoading (curva.vlm.onLoading,  'vision')
  if (curva.ocr && curva.ocr.onProgress) subscribeProgress(curva.ocr.onProgress, 'OCR')
  if (curva.ocr && curva.ocr.onLoading)  subscribeLoading (curva.ocr.onLoading,  'OCR')

  updateButtons()

  function destroy () {
    for (const off of unsubs) {
      try { off() } catch { /* noop */ }
    }
    container.textContent = ''
  }

  return { setPaused, destroy, _internal: { renderCaption, renderBlocks } }
}
