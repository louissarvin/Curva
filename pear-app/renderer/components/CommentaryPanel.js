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
  // Wave 14: STT live badge. Hidden until at least one `system:caption`
  // message flows through the chat bridge.
  const sttBadge = document.createElement('span')
  sttBadge.className = 'curva-commentary__stt-badge'
  sttBadge.textContent = 'STT live'
  sttBadge.hidden = true
  sttBadge.setAttribute('aria-live', 'polite')
  header.appendChild(flag)
  header.appendChild(title)
  header.appendChild(pulse)
  header.appendChild(chip)
  header.appendChild(sttBadge)
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

  // Wave 14: `system:caption` renderer. The chat bridge fans every reduced
  // message through onChatMessage; we filter for STT captions and render a
  // two-line block (source-language on top, viewer-locale translation below).
  // Old blocks are trimmed to at most 4 so the panel does not grow forever.
  const captionMax = 4
  const captionBlocks = []
  const myLocaleRaw = (roomState && roomState.locale)
    || (typeof navigator !== 'undefined' && navigator.language)
    || 'en'
  const myLocale = String(myLocaleRaw).slice(0, 2).toLowerCase()
  if (typeof curva.onChatMessage === 'function') {
    const offCap = curva.onChatMessage((msg) => {
      if (!msg || msg.type !== 'system:caption') return
      const rawText = typeof msg.text === 'string' ? msg.text : ''
      if (rawText.length === 0) return
      const captionWrap = document.createElement('div')
      captionWrap.className = 'curva-commentary__caption'
      const src = document.createElement('div')
      src.className = 'curva-commentary__caption-source'
      // textContent, not innerHTML. STT text is untrusted.
      src.textContent = rawText
      captionWrap.appendChild(src)
      const localized = document.createElement('div')
      localized.className = 'curva-commentary__caption-localized'
      localized.textContent = rawText // interim; may be replaced by translation
      captionWrap.appendChild(localized)
      body.appendChild(captionWrap)
      captionBlocks.push(captionWrap)
      while (captionBlocks.length > captionMax) {
        const drop = captionBlocks.shift()
        try { drop.remove() } catch { /* noop */ }
      }
      // Show the STT live badge once we have real captions flowing.
      sttBadge.hidden = false

      // Translate to the viewer's locale via the existing translate bridge.
      const captionLang = typeof msg.lang === 'string' && msg.lang.length > 0
        ? msg.lang.slice(0, 2).toLowerCase()
        : 'en'
      if (myLocale && captionLang && captionLang !== myLocale && typeof curva.translateText === 'function') {
        curva.translateText({ text: rawText, from: captionLang, to: myLocale })
          .then((res) => {
            const out = typeof res === 'string' ? res : (res && typeof res.text === 'string' ? res.text : '')
            if (out && !state.destroyed) localized.textContent = out
          })
          .catch(() => { /* keep source text as the fallback */ })
      }
    })
    offs.push(offCap)
  }

  // Tier 4: Supertonic TTS audio playback.
  // Feature-gated on curva.onAnnouncerAudio presence. One audio at a time;
  // back-to-back goal events preempt the previous clip rather than stacking.
  // Queue depth capped at 1 pending so a rapid burst is shed without delay.
  // autoplay policy: Chromium unblocks the origin once the guest has clicked
  // (Join flow). The rejection is caught and swallowed to keep the pipeline clean.
  if (typeof curva.onAnnouncerAudio === 'function') {
    let currentAudio = null
    let pendingAudio = null  // at most one queued clip behind the current

    // TTS badge: gold pill that fades after 3s.
    const ttsBadge = document.createElement('div')
    ttsBadge.className = 'curva-commentary__tts-badge'
    ttsBadge.hidden = true
    header.appendChild(ttsBadge)

    function playAudio(wavBase64, lang) {
      try {
        // Interrupt any in-flight clip.
        if (currentAudio) {
          currentAudio.pause()
          currentAudio.src = ''
          currentAudio = null
        }
        pendingAudio = null

        // Construct data URL. wavBase64 comes from Bare via IPC (Buffer.toString('base64'));
        // it is a binary blob, not user-generated prose, so no further sanitization
        // is required beyond the safe data-URI prefix. Never inserted into innerHTML.
        const src = 'data:audio/wav;base64,' + String(wavBase64 || '')
        const audio = new Audio(src)
        audio.volume = 0.9
        currentAudio = audio

        const p = audio.play()
        if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay policy; swallow */ })

        audio.addEventListener('ended', () => {
          if (currentAudio === audio) {
            currentAudio = null
            // Play next queued clip if any.
            if (pendingAudio) {
              const { b64, l } = pendingAudio
              pendingAudio = null
              playAudio(b64, l)
            }
          }
        })

        // Show gold TTS badge with 3s auto-fade.
        const safeLang = String(lang || 'en').slice(0, 5).replace(/[^a-z]/gi, '')
        ttsBadge.hidden = false
        ttsBadge.textContent = 'GOOL (' + safeLang + ')'
        ttsBadge.classList.remove('curva-commentary__tts-badge--fade')
        // Force reflow so the animation restarts on back-to-back goals.
        void ttsBadge.offsetWidth
        ttsBadge.classList.add('curva-commentary__tts-badge--fade')
      } catch (err) {
        console.warn('[announcer] playback failed:', err?.message)
      }
    }

    const offTts = curva.onAnnouncerAudio(({ wavBase64, lang, matchId: _mid }) => {
      if (!wavBase64) return
      if (currentAudio && !currentAudio.ended && !currentAudio.paused) {
        // Already playing — queue at most one pending clip; shed any earlier queued.
        pendingAudio = { b64: wavBase64, l: lang }
        return
      }
      playAudio(wavBase64, lang)
    })
    offs.push(offTts)
  }

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
