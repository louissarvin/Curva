// Curva CommentaryPanel: Wave 13A renderer for the QVAC LLM Room Commentator.
//
// Two variants toggled by `isHost`:
//   Host: tone-toggle chips + "Enable commentator (downloads ~364MB)" button.
//         Once enabled, shows a pulse animation on the AI icon while tokens
//         stream. Latest line lives in-panel; the persisted commentary lands
//         in Chat as a `system:commentary` pill.
//   Peer: "Host is not running commentator." placeholder + a live-status chip
//         (updates when the host toggles enable/disable).
//
// Feature-flag double-check: getConfig() before mounting anything. If the
// worker reports enabled:false we render a compact "disabled" strip so the
// layout doesn't jump.
//
// Security discipline (matches Chat.js / PredictionPanel.js):
//   - Every peer/model-supplied string is set via textContent, never
//     innerHTML. LLM output is arbitrary and untrusted.
//   - No external URLs (the panel is self-contained).

const TONES = [
  { id: 'italian-ultras', label: 'Italian ultras' },
  { id: 'calm-analyst', label: 'Calm analyst' },
  { id: 'hype', label: 'Hype' }
]

// Public: the feature flag test. Renderer/app.js consults this before wiring
// the panel so no DOM is created when the flag is off. Race with a 3s
// timeout so a broken worker never blocks room mount.
export async function isCommentaryPanelEnabled(curva) {
  if (!curva?.commentator?.getConfig) return false
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    const cfg = await Promise.race([curva.commentator.getConfig(), timeout])
    if (cfg && typeof cfg === 'object' && 'enabled' in cfg) return !!cfg.enabled
    // getConfig returns via event on this bridge; use onConfig once to settle.
    return await new Promise((resolve) => {
      const off = curva.commentator.onConfig?.((payload) => {
        try { off && off() } catch { /* noop */ }
        resolve(!!payload?.enabled)
      })
      setTimeout(() => { try { off && off() } catch { /* noop */ } ; resolve(false) }, 2500)
    })
  } catch { return false }
}

export function mountCommentaryPanel({ container, curva, roomState } = {}) {
  if (!container) throw new TypeError('container required')
  if (!curva?.commentator) throw new TypeError('curva.commentator bridge required')

  const isHost = !!(roomState && roomState.isHost)

  container.textContent = ''
  container.classList.add('curva-commentary')

  // Header: title + status chip + pulse indicator.
  const header = document.createElement('div')
  header.className = 'curva-commentary__header'
  const flag = document.createElement('span')
  flag.className = 'curva-commentary__flag'
  flag.textContent = '🇮🇹' // Italian flag emoji (default tone)
  flag.setAttribute('aria-hidden', 'true')
  const title = document.createElement('span')
  title.className = 'curva-commentary__title'
  title.textContent = 'AI Commentator'
  const pulse = document.createElement('span')
  pulse.className = 'curva-commentary__pulse'
  pulse.setAttribute('aria-hidden', 'true')
  const chip = document.createElement('span')
  chip.className = 'curva-commentary__chip'
  chip.textContent = 'off'
  header.appendChild(flag)
  header.appendChild(title)
  header.appendChild(pulse)
  header.appendChild(chip)
  container.appendChild(header)

  // Body: last-line preview + controls.
  const body = document.createElement('div')
  body.className = 'curva-commentary__body'
  container.appendChild(body)

  const lastLine = document.createElement('div')
  lastLine.className = 'curva-commentary__line'
  lastLine.textContent = isHost
    ? 'Enable commentator to start narrating this match.'
    : 'Host is not running commentator.'
  body.appendChild(lastLine)

  // Controls: tone chips + enable button (host only).
  const controls = document.createElement('div')
  controls.className = 'curva-commentary__controls'
  body.appendChild(controls)

  const toneBar = document.createElement('div')
  toneBar.className = 'curva-commentary__tonebar'
  controls.appendChild(toneBar)

  const toneButtons = {}
  for (const t of TONES) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'curva-commentary__tone'
    btn.dataset.tone = t.id
    btn.textContent = t.label
    btn.disabled = !isHost
    btn.addEventListener('click', () => {
      if (!isHost) return
      curva.commentator.setTone(t.id).catch(() => { /* worker emits error */ })
      applyToneUi(t.id)
    })
    toneBar.appendChild(btn)
    toneButtons[t.id] = btn
  }

  const enableBtn = document.createElement('button')
  enableBtn.type = 'button'
  enableBtn.className = 'curva-commentary__enable'
  enableBtn.hidden = !isHost
  enableBtn.textContent = 'Enable commentator (downloads ~364MB)'
  enableBtn.addEventListener('click', () => {
    if (state.enabled) {
      curva.commentator.disable().catch(() => { /* noop */ })
    } else {
      enableBtn.disabled = true
      enableBtn.textContent = 'Loading LLM…'
      curva.commentator.enable().catch(() => { /* worker emits error */ })
    }
  })
  controls.appendChild(enableBtn)

  const progress = document.createElement('div')
  progress.className = 'curva-commentary__progress'
  progress.hidden = true
  const progressBar = document.createElement('div')
  progressBar.className = 'curva-commentary__progress-bar'
  progress.appendChild(progressBar)
  body.appendChild(progress)

  const errorBanner = document.createElement('div')
  errorBanner.className = 'curva-commentary__error'
  errorBanner.hidden = true
  body.appendChild(errorBanner)

  const state = {
    enabled: false,
    modelLoaded: false,
    streaming: false,
    tone: 'italian-ultras',
    streamingBuffer: '',
    destroyed: false
  }

  function applyToneUi(tone) {
    state.tone = tone
    for (const [id, btn] of Object.entries(toneButtons)) {
      btn.classList.toggle('curva-commentary__tone--active', id === tone)
    }
    // Italian flag emoji only for the ultras tone; a neutral marker otherwise.
    flag.textContent = tone === 'italian-ultras' ? '🇮🇹' : '◆'
  }

  function applyStatus(st) {
    if (!st || typeof st !== 'object') return
    if (typeof st.enabled === 'boolean') state.enabled = st.enabled
    if (typeof st.modelLoaded === 'boolean') state.modelLoaded = st.modelLoaded
    if (typeof st.streaming === 'boolean') state.streaming = st.streaming
    if (typeof st.tone === 'string') applyToneUi(st.tone)
    chip.textContent = state.enabled
      ? (state.modelLoaded ? (state.streaming ? 'streaming…' : 'ready') : 'loading…')
      : 'off'
    pulse.classList.toggle('curva-commentary__pulse--active', !!state.streaming)
    if (isHost) {
      enableBtn.disabled = false
      if (state.enabled && state.modelLoaded) {
        enableBtn.textContent = 'Disable commentator'
      } else if (state.enabled && !state.modelLoaded) {
        enableBtn.textContent = 'Loading LLM…'
        enableBtn.disabled = true
      } else {
        enableBtn.textContent = 'Enable commentator (downloads ~364MB)'
      }
    }
  }

  function setError(msg) {
    if (!msg) { errorBanner.hidden = true; errorBanner.textContent = ''; return }
    errorBanner.hidden = false
    errorBanner.textContent = String(msg).slice(0, 240)
  }

  // Wire event subscriptions. Each is stored so destroy() can unwire.
  const offs = []
  offs.push(curva.commentator.onConfig((p) => applyStatus(p)))
  offs.push(curva.commentator.onStatus((p) => applyStatus(p)))
  offs.push(curva.commentator.onLoading(() => {
    progress.hidden = false
    progressBar.style.width = '0%'
    setError(null)
  }))
  offs.push(curva.commentator.onProgress((p) => {
    progress.hidden = false
    const pct = typeof p?.percentage === 'number' ? Math.max(0, Math.min(100, p.percentage)) : null
    if (pct !== null) progressBar.style.width = pct + '%'
  }))
  offs.push(curva.commentator.onReady(() => {
    progress.hidden = true
    progressBar.style.width = '100%'
    setError(null)
  }))
  offs.push(curva.commentator.onTrigger(() => {
    state.streamingBuffer = ''
    state.streaming = true
    pulse.classList.add('curva-commentary__pulse--active')
    // Placeholder text while first tokens arrive.
    lastLine.textContent = '…'
    lastLine.classList.add('curva-commentary__line--streaming')
  }))
  offs.push(curva.commentator.onTokens((p) => {
    if (typeof p?.token !== 'string') return
    state.streamingBuffer += p.token
    // textContent, not innerHTML. LLM output is untrusted.
    lastLine.textContent = state.streamingBuffer.slice(0, 400)
  }))
  offs.push(curva.commentator.onEmitted((p) => {
    if (typeof p?.text === 'string') lastLine.textContent = p.text
    state.streaming = false
    pulse.classList.remove('curva-commentary__pulse--active')
    lastLine.classList.remove('curva-commentary__line--streaming')
  }))
  offs.push(curva.commentator.onError((p) => {
    setError(p?.message || p?.code || 'commentator error')
    state.streaming = false
    pulse.classList.remove('curva-commentary__pulse--active')
  }))

  // Kick off: fetch status so the panel reflects reality on mount.
  curva.commentator.getStatus().catch(() => { /* worker emits status */ })

  function destroy() {
    if (state.destroyed) return
    state.destroyed = true
    for (const off of offs) { try { off && off() } catch { /* noop */ } }
    try { container.textContent = '' } catch { /* noop */ }
    try { container.classList.remove('curva-commentary') } catch { /* noop */ }
  }

  return { destroy, _state: state, _dom: { chip, lastLine, enableBtn } }
}
