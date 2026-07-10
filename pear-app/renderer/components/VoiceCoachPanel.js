// Curva VoiceCoachPanel: Wave 15 renderer for the Voice-Controlled Coach.
//
// Push-to-talk button that captures 16 kHz mono f32le PCM from the mic, streams
// it through curva.voiceCoach.pushAudio(), then displays the streamed answer
// and speaks it back via TTS (announcer.js, on the worker side).
//
// Ground truth for the audio-capture path:
//   - AudioContext + MediaStreamSource + AudioWorkletNode is the modern MDN
//     recommendation. See
//     https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode
//     (fetched 2026-07-10). ScriptProcessorNode is deprecated but supported by
//     Electron/Chromium for another cycle; we prefer AudioWorklet with a
//     ScriptProcessor fallback so the demo still runs on older builds.
//   - AudioContext sample rate is 48 kHz on macOS by default. We downsample to
//     16 kHz on the JS side with a simple 3:1 average decimation — Whisper is
//     tolerant to this and it avoids pulling in a resampler dep.
//   - The AudioBuffer render callback delivers Float32 in [-1,1]. The SDK's
//     whisper addon accepts f32le PCM directly (see WHISPER_STT_CONFIG
//     audio_format:'f32le' in bare/commentator.js), so we forward the Float32
//     bytes as-is via Uint8Array views.
//
// Security discipline (matches Chat.js / CommentaryPanel.js):
//   - All bridge-supplied strings go through textContent, never innerHTML.
//   - Answer + transcript previews are rendered token-by-token; each append is
//     an append-to-textContent, so an LLM producing HTML/JS is inert.
//   - The mic permission prompt is guarded so a denial only disables PTT and
//     does NOT wedge the panel.

const KEY_PTT = ' '   // space bar

// Public feature-flag check called from renderer/app.js before mounting.
// Follows the same 3s race pattern as CommentaryPanel.isCommentaryPanelEnabled.
export async function isVoiceCoachEnabled(curva) {
  if (!curva?.voiceCoach?.status) return false
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    const cfg = await Promise.race([curva.voiceCoach.status(), timeout])
    if (cfg && typeof cfg === 'object') {
      // Panel is enabled when the worker reports both an STT model handle and
      // a shared LLM handle. Without either the coach cannot answer.
      return !!(cfg.hasSdk && cfg.hasLlm)
    }
    return false
  } catch { return false }
}

/**
 * Mount the panel.
 *
 * @param {{
 *   container: HTMLElement,
 *   curva: {
 *     voiceCoach: {
 *       startTurn: () => Promise<any>,
 *       endTurn: () => Promise<any>,
 *       pushAudio: (bytes: Uint8Array) => Promise<any>,
 *       status: () => Promise<any>,
 *       on?: (evt: string, cb: (payload: any) => void) => (() => void)
 *     }
 *   },
 *   roomState?: object
 * }} params
 */
export function mountVoiceCoachPanel({ container, curva, roomState } = {}) {
  if (!container) throw new TypeError('container required')
  if (!curva?.voiceCoach) throw new TypeError('curva.voiceCoach bridge required')

  container.textContent = ''
  container.classList.add('curva-voice-coach')

  // --- DOM tree -----------------------------------------------------------

  const header = document.createElement('div')
  header.className = 'curva-voice-coach__header'
  const title = document.createElement('span')
  title.className = 'curva-voice-coach__title'
  title.textContent = 'Voice Coach'
  const chip = document.createElement('span')
  chip.className = 'curva-voice-coach__chip'
  chip.textContent = 'idle'
  chip.setAttribute('aria-live', 'polite')
  header.appendChild(title)
  header.appendChild(chip)

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'curva-voice-coach__ptt'
  btn.textContent = 'Hold to talk (Space)'
  btn.setAttribute('aria-label', 'Push to talk')

  // wave-final QVAC depth F1: Cancel button appears only while the LLM is
  // streaming an answer. Clicking calls curva.voiceCoach.cancel() which
  // routes to sdk.cancel({requestId}) in the worker. XSS-safe: textContent
  // only. See @qvac/sdk dist/client/api/cancel.d.ts:6-15.
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'curva-voice-coach__cancel'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.setAttribute('aria-label', 'Cancel streaming answer')
  cancelBtn.hidden = true

  const transcript = document.createElement('div')
  transcript.className = 'curva-voice-coach__transcript'
  transcript.setAttribute('aria-live', 'polite')
  transcript.textContent = ''

  const answer = document.createElement('div')
  answer.className = 'curva-voice-coach__answer'
  answer.setAttribute('aria-live', 'polite')
  answer.textContent = ''

  const meta = document.createElement('div')
  meta.className = 'curva-voice-coach__meta'
  meta.textContent = ''

  const hint = document.createElement('div')
  hint.className = 'curva-voice-coach__hint'
  hint.textContent = 'spoken via QVAC on-device TTS'
  hint.hidden = true

  container.appendChild(header)
  container.appendChild(btn)
  container.appendChild(cancelBtn)
  container.appendChild(transcript)
  container.appendChild(answer)
  container.appendChild(meta)
  container.appendChild(hint)

  // --- State --------------------------------------------------------------

  const state = {
    active: false,
    audioCtx: null,
    micStream: null,
    workletNode: null,
    scriptNode: null,
    micSource: null,
    // Ring buffer of Float32 samples awaiting flush to the worker.
    outSamples: [],
    // Rate-limit flushes to at most every 60 ms so we do not spam the IPC.
    lastFlushAt: 0,
    // Track subscription unsubs so we can tear down cleanly on unmount.
    unsubs: []
  }

  // --- Event wiring on the coach bridge ----------------------------------

  function trySubscribe(evt, cb) {
    if (typeof curva.voiceCoach.on !== 'function') return
    const off = curva.voiceCoach.on(evt, cb)
    if (typeof off === 'function') state.unsubs.push(off)
  }

  trySubscribe('voice:transcript-partial', (p) => {
    if (!p || typeof p !== 'object') return
    // textContent-only. LLM/STT-supplied string is untrusted.
    transcript.textContent = String(p.cumulative || p.text || '')
  })
  trySubscribe('voice:transcript-final', (p) => {
    if (!p || typeof p !== 'object') return
    transcript.textContent = String(p.text || '')
  })
  trySubscribe('voice:answer-token', (p) => {
    if (!p || typeof p !== 'object') return
    const chunk = typeof p.text === 'string' ? p.text : ''
    if (chunk.length === 0) return
    answer.textContent = answer.textContent + chunk
    // wave-final QVAC depth F1: first token = streaming has begun. Reveal
    // the Cancel button. The worker only exposes a requestId once the SDK's
    // completion() call returns, and the first token guarantees we are
    // past that point.
    cancelBtn.hidden = false
    cancelBtn.disabled = false
  })
  trySubscribe('voice:done', (p) => {
    if (!p || typeof p !== 'object') return
    const ms = Number(p.latencyMs) || 0
    meta.textContent = ms > 0 ? (ms + ' ms round-trip') : ''
    hint.hidden = false
    setChip('idle')
    cancelBtn.hidden = true
    cancelBtn.disabled = false
  })
  trySubscribe('voice:cancelled', () => {
    cancelBtn.disabled = true
    cancelBtn.textContent = 'Cancelled'
    setTimeout(() => {
      cancelBtn.hidden = true
      cancelBtn.disabled = false
      cancelBtn.textContent = 'Cancel'
    }, 800)
  })
  trySubscribe('voice:vad', (p) => {
    if (!p || typeof p !== 'object') return
    btn.classList.toggle('is-speaking', !!p.speaking)
  })
  trySubscribe('voice:error', (p) => {
    setChip('error')
    if (p && typeof p.message === 'string') meta.textContent = p.message.slice(0, 120)
  })

  // --- Chip helper --------------------------------------------------------

  function setChip(kind) {
    chip.classList.remove('is-idle', 'is-listening', 'is-error')
    if (kind === 'listening') { chip.classList.add('is-listening'); chip.textContent = 'listening' }
    else if (kind === 'error') { chip.classList.add('is-error'); chip.textContent = 'error' }
    else { chip.classList.add('is-idle'); chip.textContent = 'idle' }
  }
  setChip('idle')

  // --- Audio capture ------------------------------------------------------

  /**
   * Ensure we have an AudioContext + MediaStream + capture graph. The graph
   * pushes Float32Array frames into `state.outSamples` at the OS sample rate.
   * We downsample to 16 kHz in `flushToWorker` before shipping over IPC.
   */
  async function ensureMic() {
    if (state.audioCtx && state.micStream) return true
    if (!navigator?.mediaDevices?.getUserMedia) {
      meta.textContent = 'mic access unavailable in this runtime'
      return false
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      } })
      const AC = window.AudioContext || window.webkitAudioContext
      const ctx = new AC()
      const src = ctx.createMediaStreamSource(stream)
      // Prefer ScriptProcessor because it works synchronously in older Electron
      // builds without needing a worklet URL. Buffer size 2048 at 48 kHz gives
      // ~43 ms cadence, well under Whisper's chunk boundary.
      const SP = ctx.createScriptProcessor ? ctx.createScriptProcessor.bind(ctx) : null
      if (!SP) {
        meta.textContent = 'audio capture API unavailable'
        stream.getTracks().forEach((t) => t.stop())
        ctx.close && ctx.close()
        return false
      }
      const proc = SP(2048, 1, 1)
      proc.onaudioprocess = (e) => {
        if (!state.active) return
        const input = e.inputBuffer.getChannelData(0)
        // Copy so the ring buffer entry survives the callback.
        state.outSamples.push(new Float32Array(input))
        flushToWorker(ctx.sampleRate).catch(() => { /* noop */ })
      }
      src.connect(proc)
      // Connect proc to destination so onaudioprocess actually fires on some
      // browsers. Mute by wrapping in a zero-gain node.
      const gain = ctx.createGain()
      gain.gain.value = 0
      proc.connect(gain).connect(ctx.destination)
      state.audioCtx = ctx
      state.micStream = stream
      state.scriptNode = proc
      state.micSource = src
      return true
    } catch (err) {
      const reason = (err && err.name === 'NotAllowedError') ? 'mic permission denied'
        : (err && err.message) || 'mic error'
      meta.textContent = String(reason).slice(0, 120)
      setChip('error')
      return false
    }
  }

  /**
   * Downsample buffered Float32 samples from the OS rate to 16 kHz using
   * simple decimation (average N samples per output sample where N = ratio).
   * For 48000 -> 16000 that is exactly N=3, so each 2048-sample buffer
   * becomes ~682 output samples.
   */
  function downsampleTo16k(samples, srcRate) {
    if (srcRate === 16_000) return samples
    const ratio = srcRate / 16_000
    if (!(ratio > 1)) return samples
    const outLen = Math.floor(samples.length / ratio)
    const out = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio)
      const end = Math.min(samples.length, Math.floor((i + 1) * ratio))
      let sum = 0, n = 0
      for (let j = start; j < end; j++) { sum += samples[j]; n++ }
      out[i] = n > 0 ? sum / n : 0
    }
    return out
  }

  async function flushToWorker(srcRate) {
    const now = performance.now ? performance.now() : Date.now()
    if (now - state.lastFlushAt < 60) return
    state.lastFlushAt = now
    if (state.outSamples.length === 0) return
    // Concatenate ring entries into one buffer.
    let totalIn = 0
    for (const b of state.outSamples) totalIn += b.length
    const merged = new Float32Array(totalIn)
    let cursor = 0
    for (const b of state.outSamples) { merged.set(b, cursor); cursor += b.length }
    state.outSamples.length = 0
    const down = downsampleTo16k(merged, srcRate || 48_000)
    // Ship as Uint8Array over the f32le byte view.
    const bytes = new Uint8Array(down.buffer, down.byteOffset, down.byteLength)
    try {
      await curva.voiceCoach.pushAudio(bytes)
    } catch (err) {
      // Do not throw into an onaudioprocess callback.
      setChip('error')
      meta.textContent = String((err && err.message) || 'push failed').slice(0, 120)
    }
  }

  // --- PTT lifecycle ------------------------------------------------------

  let starting = false
  async function beginPTT() {
    if (state.active || starting) return
    starting = true
    try {
      answer.textContent = ''
      transcript.textContent = ''
      meta.textContent = ''
      hint.hidden = true
      setChip('listening')
      const micOk = await ensureMic()
      if (!micOk) { setChip('error'); return }
      try {
        await curva.voiceCoach.startTurn()
      } catch (err) {
        setChip('error')
        meta.textContent = String((err && err.message) || 'startTurn failed').slice(0, 120)
        return
      }
      state.active = true
      btn.classList.add('is-active')
    } finally {
      starting = false
    }
  }

  async function endPTT() {
    if (!state.active) return
    state.active = false
    btn.classList.remove('is-active')
    // Flush any tail samples before signalling end.
    try {
      if (state.outSamples.length > 0 && state.audioCtx) {
        state.lastFlushAt = 0
        await flushToWorker(state.audioCtx.sampleRate)
      }
    } catch { /* noop */ }
    try { await curva.voiceCoach.endTurn() } catch (err) {
      setChip('error')
      meta.textContent = String((err && err.message) || 'endTurn failed').slice(0, 120)
    }
  }

  // --- Bindings -----------------------------------------------------------

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    beginPTT()
  })
  btn.addEventListener('pointerup', (e) => {
    e.preventDefault()
    endPTT()
  })
  btn.addEventListener('pointercancel', () => { endPTT() })
  btn.addEventListener('pointerleave', () => { if (state.active) endPTT() })

  cancelBtn.addEventListener('click', (e) => {
    e.preventDefault()
    if (cancelBtn.disabled) return
    cancelBtn.disabled = true
    if (typeof curva.voiceCoach.cancel === 'function') {
      // Fire-and-forget. The onCancelled handler handles the visual reset.
      try { curva.voiceCoach.cancel() } catch { /* noop */ }
    }
  })

  function onKeyDown(e) {
    if (e.repeat) return
    if (e.key !== KEY_PTT) return
    const tag = (e.target && e.target.tagName) || ''
    if (tag === 'INPUT' || tag === 'TEXTAREA') return  // do not steal typing
    e.preventDefault()
    beginPTT()
  }
  function onKeyUp(e) {
    if (e.key !== KEY_PTT) return
    endPTT()
  }
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)

  // --- Teardown -----------------------------------------------------------

  function unmount() {
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)
    for (const off of state.unsubs) { try { off() } catch { /* noop */ } }
    state.unsubs.length = 0
    if (state.scriptNode) { try { state.scriptNode.disconnect() } catch { /* noop */ } }
    if (state.micSource) { try { state.micSource.disconnect() } catch { /* noop */ } }
    if (state.micStream) {
      try { state.micStream.getTracks().forEach((t) => t.stop()) } catch { /* noop */ }
    }
    if (state.audioCtx && state.audioCtx.close) {
      try { state.audioCtx.close() } catch { /* noop */ }
    }
    state.audioCtx = null
    state.micStream = null
    state.scriptNode = null
    state.micSource = null
    state.outSamples.length = 0
    container.classList.remove('curva-voice-coach')
    container.textContent = ''
  }

  return { unmount, roomState: roomState || null }
}
