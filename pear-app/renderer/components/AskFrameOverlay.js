// AskFrameOverlay — F3: Press `?` to open a floating overlay over VideoPlayer.
// Captures the current frame, streams an LLM answer token-by-token, lets the
// user copy the result to chat as system:ask-frame-answer.
//
// Security:
//   - question: validated max 500 chars, textContent only
//   - answer tokens: textContent only (model output is untrusted)
//   - Escape closes; focus trap is lightweight (overlay auto-focuses input)
//   - No innerHTML anywhere
//
// Mount contract: mountAskFrameOverlay({ container, curva, getVideoPlayer })
//   container: document.body (overlay is fixed-position)
//   curva: the preload bridge
//   getVideoPlayer: () => videoPlayer instance (may return null if room not open)
//
// Returns { destroy() }

const MAX_QUESTION = 500

export function mountAskFrameOverlay({ container, curva, getVideoPlayer } = {}) {
  if (!container) throw new TypeError('container is required')
  if (!curva) throw new TypeError('curva bridge is required')

  // -- Build DOM ------------------------------------------------------------

  const overlay = document.createElement('div')
  overlay.className = 'curva-ask-overlay'
  overlay.hidden = true
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Ask about this frame')

  const backdrop = document.createElement('div')
  backdrop.className = 'curva-ask-overlay__backdrop'

  const card = document.createElement('div')
  card.className = 'curva-ask-overlay__card'

  // Header row
  const header = document.createElement('div')
  header.className = 'curva-ask-overlay__header'

  const titleEl = document.createElement('span')
  titleEl.className = 'curva-ask-overlay__title'
  titleEl.textContent = 'ask the frame'

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'curva-ask-overlay__close'
  closeBtn.textContent = 'close'
  closeBtn.setAttribute('aria-label', 'Close ask-frame overlay')

  header.appendChild(titleEl)
  header.appendChild(closeBtn)

  // Frame preview label
  const frameStatus = document.createElement('div')
  frameStatus.className = 'curva-ask-overlay__frame-status'
  frameStatus.textContent = 'no frame captured'

  // Question input row
  const inputRow = document.createElement('div')
  inputRow.className = 'curva-ask-overlay__input-row'

  const questionInput = document.createElement('input')
  questionInput.type = 'text'
  questionInput.className = 'curva-ask-overlay__question'
  questionInput.placeholder = 'What do you see in this frame?'
  questionInput.maxLength = MAX_QUESTION + 10
  questionInput.setAttribute('aria-label', 'Question about the current frame')
  questionInput.autocomplete = 'off'

  const charCount = document.createElement('span')
  charCount.className = 'curva-ask-overlay__charcount'
  charCount.textContent = '0 / ' + MAX_QUESTION

  const askBtn = document.createElement('button')
  askBtn.type = 'button'
  askBtn.className = 'curva-ask-overlay__ask-btn'
  askBtn.textContent = 'Ask'

  // wave-final QVAC depth F1: Cancel button visible only while an ask is in
  // flight. Wired to curva.askFrame.cancel() which routes to sdk.cancel({
  // requestId}) in the worker. Verified per @qvac/sdk cancel.d.ts:6-15.
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'curva-ask-overlay__cancel-btn'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.hidden = true

  inputRow.appendChild(questionInput)
  inputRow.appendChild(charCount)
  inputRow.appendChild(askBtn)
  inputRow.appendChild(cancelBtn)

  // Answer streaming area
  const answerEl = document.createElement('div')
  answerEl.className = 'curva-ask-overlay__answer'
  answerEl.hidden = true

  const answerLabel = document.createElement('div')
  answerLabel.className = 'curva-ask-overlay__answer-label'
  answerLabel.textContent = 'answer'

  const answerText = document.createElement('div')
  answerText.className = 'curva-ask-overlay__answer-text'

  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'curva-ask-overlay__copy-btn'
  copyBtn.textContent = 'Copy to chat'
  copyBtn.hidden = true

  answerEl.appendChild(answerLabel)
  answerEl.appendChild(answerText)
  answerEl.appendChild(copyBtn)

  card.appendChild(header)
  card.appendChild(frameStatus)
  card.appendChild(inputRow)
  card.appendChild(answerEl)

  overlay.appendChild(backdrop)
  overlay.appendChild(card)
  container.appendChild(overlay)

  // -- State ----------------------------------------------------------------

  let isOpen = false
  let capturedFrame = null // data URL or null
  let currentAnswer = ''
  let asking = false

  // -- Helpers --------------------------------------------------------------

  function open() {
    if (isOpen) return
    isOpen = true
    overlay.hidden = false
    // Capture frame immediately on open
    capturedFrame = null
    currentAnswer = ''
    answerText.textContent = ''
    answerEl.hidden = true
    copyBtn.hidden = true
    asking = false
    askBtn.disabled = false
    askBtn.textContent = 'Ask'

    const vp = typeof getVideoPlayer === 'function' ? getVideoPlayer() : null
    if (vp && typeof vp.captureFrame === 'function') {
      capturedFrame = vp.captureFrame()
    }
    frameStatus.textContent = capturedFrame
      ? 'frame captured'
      : 'no frame — pause the video first'

    questionInput.value = ''
    charCount.textContent = '0 / ' + MAX_QUESTION
    setTimeout(() => questionInput.focus(), 0)
  }

  function close() {
    if (!isOpen) return
    isOpen = false
    overlay.hidden = true
  }

  function updateCharCount() {
    const len = Math.min(questionInput.value.length, MAX_QUESTION)
    charCount.textContent = len + ' / ' + MAX_QUESTION
    if (questionInput.value.length > MAX_QUESTION) {
      charCount.classList.add('curva-ask-overlay__charcount--over')
    } else {
      charCount.classList.remove('curva-ask-overlay__charcount--over')
    }
  }

  async function submitQuestion() {
    if (asking) return
    const question = questionInput.value.slice(0, MAX_QUESTION).trim()
    if (question.length === 0) return
    if (!capturedFrame) {
      frameStatus.textContent = 'no frame — pause the video and try again'
      return
    }

    if (typeof curva.askFrame?.ask !== 'function') {
      answerEl.hidden = false
      answerText.textContent = 'ask-frame API unavailable'
      return
    }

    asking = true
    askBtn.disabled = true
    askBtn.textContent = 'Asking...'
    currentAnswer = ''
    answerText.textContent = ''
    answerEl.hidden = false
    copyBtn.hidden = true
    // Cancel becomes available the moment we hit the wire; the worker will
    // no-op the cancel if the SDK has not yet returned a requestId (see
    // askTheFrame.js cancel()).
    cancelBtn.hidden = false
    cancelBtn.disabled = false
    cancelBtn.textContent = 'Cancel'

    try {
      await curva.askFrame.ask({ image: capturedFrame, question })
    } catch (err) {
      answerText.textContent = 'error: ' + (err?.message || 'unknown')
      asking = false
      askBtn.disabled = false
      askBtn.textContent = 'Ask'
      cancelBtn.hidden = true
    }
  }

  // -- Event subscriptions --------------------------------------------------

  // Subscribe to answer events. Best-effort; older workers without askFrame
  // silently no-op. We unconditionally wire these so they work from the moment
  // the component mounts, not just when the overlay is open.
  let offStarted = () => {}
  let offCaption = () => {}
  let offToken = () => {}
  let offDone = () => {}

  if (typeof curva.askFrame?.onStarted === 'function') {
    offStarted = curva.askFrame.onStarted(() => {
      answerText.textContent = ''
      currentAnswer = ''
    })
  }

  if (typeof curva.askFrame?.onCaption === 'function') {
    offCaption = curva.askFrame.onCaption((payload) => {
      const text = typeof payload?.text === 'string' ? payload.text : String(payload || '')
      currentAnswer = text
      answerText.textContent = currentAnswer
    })
  }

  if (typeof curva.askFrame?.onToken === 'function') {
    offToken = curva.askFrame.onToken((payload) => {
      const token = typeof payload?.token === 'string' ? payload.token : String(payload || '')
      currentAnswer += token
      answerText.textContent = currentAnswer
    })
  }

  if (typeof curva.askFrame?.onDone === 'function') {
    offDone = curva.askFrame.onDone(() => {
      asking = false
      askBtn.disabled = false
      askBtn.textContent = 'Ask'
      copyBtn.hidden = currentAnswer.length === 0
      cancelBtn.hidden = true
      cancelBtn.disabled = false
      cancelBtn.textContent = 'Cancel'
    })
  }

  let offCancelled = () => {}
  if (typeof curva.askFrame?.onCancelled === 'function') {
    offCancelled = curva.askFrame.onCancelled(() => {
      cancelBtn.textContent = 'Cancelled'
      cancelBtn.disabled = true
      // The worker will also emit onDone after the SDK finalises the run;
      // we let that reset the button. If it never comes, hide after 800 ms
      // as a safety net.
      setTimeout(() => {
        cancelBtn.hidden = true
        cancelBtn.textContent = 'Cancel'
        cancelBtn.disabled = false
      }, 800)
    })
  }

  // -- DOM event listeners --------------------------------------------------

  questionInput.addEventListener('input', updateCharCount)

  questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); return }
    if (e.key === 'Enter') { submitQuestion() }
  })

  askBtn.addEventListener('click', () => submitQuestion())
  cancelBtn.addEventListener('click', (e) => {
    e.preventDefault()
    if (cancelBtn.disabled) return
    cancelBtn.disabled = true
    if (typeof curva.askFrame?.cancel === 'function') {
      try { curva.askFrame.cancel() } catch { /* noop */ }
    }
  })
  closeBtn.addEventListener('click', () => close())

  backdrop.addEventListener('click', () => close())

  // Prevent card clicks from closing via backdrop
  card.addEventListener('click', (e) => e.stopPropagation())

  copyBtn.addEventListener('click', () => {
    if (!currentAnswer || currentAnswer.length === 0) return
    const text = currentAnswer.slice(0, 4000)
    const matchTimeMs = (() => {
      try {
        const vp = typeof getVideoPlayer === 'function' ? getVideoPlayer() : null
        return vp && vp.video ? Math.floor(vp.video.currentTime * 1000) : 0
      } catch { return 0 }
    })()
    if (typeof curva.chat?.sendSystem === 'function') {
      curva.chat.sendSystem({
        type: 'system:ask-frame-answer',
        text,
        match_time_ms: matchTimeMs
      }).catch(() => {})
    }
    copyBtn.textContent = 'Sent!'
    setTimeout(() => { copyBtn.textContent = 'Copy to chat' }, 1500)
    close()
  })

  // -- Global keyboard handler ----------------------------------------------

  function onKeyDown(e) {
    // `?` = Shift+/ on US layout. key === '?' covers it cross-platform.
    if (e.key === '?' && !isInputFocused(e)) {
      e.preventDefault()
      if (isOpen) close()
      else open()
      return
    }
    if (e.key === 'Escape' && isOpen) {
      close()
    }
  }

  function isInputFocused(e) {
    const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : ''
    return tag === 'input' || tag === 'textarea' || tag === 'select'
      || (e.target && e.target.isContentEditable)
  }

  document.addEventListener('keydown', onKeyDown)

  // -- Destroy --------------------------------------------------------------

  function destroy() {
    document.removeEventListener('keydown', onKeyDown)
    try { offStarted() } catch { /* noop */ }
    try { offCaption() } catch { /* noop */ }
    try { offToken() } catch { /* noop */ }
    try { offDone() } catch { /* noop */ }
    try { offCancelled() } catch { /* noop */ }
    try { overlay.remove() } catch { /* noop */ }
  }

  return { destroy, open, close }
}
