// Curva VoiceEnrollmentModal — F2: record 15s, enroll voice clone.
//
// Security:
//   - textContent everywhere; no innerHTML, no user data in DOM sinks.
//   - Audio captured from MediaStream, never from a URL parameter or peer input.
//   - curva.voiceClone bridge must exist before the modal is shown; the
//     trigger button in RoomHeader is hidden when the bridge is absent.
//   - No external URLs opened.
//
// WebAudio pipeline: getUserMedia -> AudioContext (16 kHz) ->
//   MediaStreamAudioSourceNode -> ScriptProcessorNode (bufferSize 4096) ->
//   Float32 PCM accumulator -> on stop: pass to curva.voiceClone.enroll().
//
// ScriptProcessor is deprecated but remains the only choice that works inside
// Electron's renderer without a dedicated audio worklet module file. The node
// is disconnected on stop so no timer leaks occur.

const RECORD_SECONDS = 15
const TARGET_SAMPLE_RATE = 16_000
const SCRIPT_BUFFER_SIZE = 4096

// Encode a Float32Array (range roughly [-1, 1]) as a 16-bit little-endian
// mono WAV file. Chatterbox voice-clone expects a WAV container, not raw
// PCM samples. Layout follows the canonical PCM WAV RIFF spec:
//   [ 0 .. 4]   'RIFF'
//   [ 4 .. 8]   uint32 LE file size - 8
//   [ 8 ..12]   'WAVE'
//   [12 ..16]   'fmt '
//   [16 ..20]   uint32 LE 16 (fmt chunk size)
//   [20 ..22]   uint16 LE 1  (PCM format)
//   [22 ..24]   uint16 LE 1  (num channels = mono)
//   [24 ..28]   uint32 LE sampleRate
//   [28 ..32]   uint32 LE byteRate  = sampleRate * numChan * bytesPerSample
//   [32 ..34]   uint16 LE blockAlign = numChan * bytesPerSample
//   [34 ..36]   uint16 LE 16 (bits per sample)
//   [36 ..40]   'data'
//   [40 ..44]   uint32 LE dataChunkSize
//   [44 ..  ]   int16 LE samples
// Docs: https://docs.fileformat.com/audio/wav/ + WAVEFORMATEX/RIFF WAV spec.
function float32PcmToWav16Bit (float32Samples, sampleRate) {
  const numChannels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const byteRate = sampleRate * numChannels * bytesPerSample
  const blockAlign = numChannels * bytesPerSample
  const dataLength = float32Samples.length * bytesPerSample
  const headerLength = 44
  const total = headerLength + dataLength
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  // 'RIFF'
  view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46)
  view.setUint32(4, total - 8, true)
  // 'WAVE'
  view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45)
  // 'fmt '
  view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20)
  view.setUint32(16, 16, true)                // fmt chunk size
  view.setUint16(20, 1, true)                 // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  // 'data'
  view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61)
  view.setUint32(40, dataLength, true)
  let offset = headerLength
  for (let i = 0; i < float32Samples.length; i++) {
    // Clamp then convert [-1, 1] Float32 -> Int16 range [-32768, 32767]
    let s = float32Samples[i]
    if (s > 1) s = 1
    else if (s < -1) s = -1
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
    offset += 2
  }
  return out
}

export function mountVoiceEnrollmentModal({ container, curva, isHost } = {}) {
  if (!container) throw new TypeError('container required')
  if (!curva) throw new TypeError('curva bridge required')

  let destroyed = false
  let modalEl = null
  let audioCtx = null
  let mediaStream = null
  let scriptNode = null
  let sourceNode = null
  let pcmChunks = []
  let recordedPcm = null  // Float32Array after recording
  let countdownTimer = null
  let waveformTimer = null
  let analyserNode = null
  let isRecording = false
  let recordedBlob = null  // for preview playback
  const subs = []

  function destroy() {
    if (destroyed) return
    destroyed = true
    stopCapture()
    if (modalEl) { try { modalEl.remove() } catch { /* noop */ } modalEl = null }
    for (const off of subs) { try { off && off() } catch { /* noop */ } }
  }

  // Downsample Float32 from deviceSampleRate to 16 kHz using linear
  // interpolation. Keeping it simple: the model only needs intelligible speech.
  function downsample(input, fromRate, toRate) {
    if (fromRate === toRate) return input
    const ratio = fromRate / toRate
    const outLen = Math.floor(input.length / ratio)
    const out = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const src = i * ratio
      const lo = Math.floor(src)
      const hi = Math.min(lo + 1, input.length - 1)
      const frac = src - lo
      out[i] = input[lo] * (1 - frac) + input[hi] * frac
    }
    return out
  }

  function stopCapture() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null }
    if (waveformTimer) { cancelAnimationFrame(waveformTimer); waveformTimer = null }
    if (scriptNode) {
      try { scriptNode.disconnect() } catch { /* noop */ }
      scriptNode = null
    }
    if (sourceNode) {
      try { sourceNode.disconnect() } catch { /* noop */ }
      sourceNode = null
    }
    if (analyserNode) {
      try { analyserNode.disconnect() } catch { /* noop */ }
      analyserNode = null
    }
    if (mediaStream) {
      try { mediaStream.getTracks().forEach((t) => t.stop()) } catch { /* noop */ }
      mediaStream = null
    }
    if (audioCtx) {
      try { audioCtx.close() } catch { /* noop */ }
      audioCtx = null
    }
    isRecording = false
  }

  function flattenPcm(chunks) {
    let total = 0
    for (const c of chunks) total += c.length
    const out = new Float32Array(total)
    let offset = 0
    for (const c of chunks) { out.set(c, offset); offset += c.length }
    return out
  }

  // Build a WAV blob from Float32 PCM at 16 kHz mono for preview playback.
  function pcmToWavBlob(pcm, sampleRate) {
    const numSamples = pcm.length
    const buffer = new ArrayBuffer(44 + numSamples * 2)
    const view = new DataView(buffer)
    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
    }
    writeStr(0, 'RIFF')
    view.setUint32(4, 36 + numSamples * 2, true)
    writeStr(8, 'WAVE')
    writeStr(12, 'fmt ')
    view.setUint32(16, 16, true)    // subchunk size
    view.setUint16(20, 1, true)     // PCM
    view.setUint16(22, 1, true)     // mono
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * 2, true)  // byte rate
    view.setUint16(32, 2, true)     // block align
    view.setUint16(34, 16, true)    // bits per sample
    writeStr(36, 'data')
    view.setUint32(40, numSamples * 2, true)
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]))
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    return new Blob([buffer], { type: 'audio/wav' })
  }

  function openModal() {
    if (modalEl) return  // already open

    modalEl = document.createElement('div')
    modalEl.className = 'curva-voice-enroll'
    modalEl.setAttribute('role', 'dialog')
    modalEl.setAttribute('aria-modal', 'true')
    modalEl.setAttribute('aria-label', 'Clone your voice for AI commentary')

    const backdrop = document.createElement('div')
    backdrop.className = 'curva-voice-enroll__backdrop'
    backdrop.addEventListener('click', closeModal)

    const card = document.createElement('div')
    card.className = 'curva-voice-enroll__card'

    // Header
    const titleEl = document.createElement('div')
    titleEl.className = 'curva-voice-enroll__title'
    titleEl.textContent = 'Clone your voice for AI commentary'

    const explainer = document.createElement('p')
    explainer.className = 'curva-voice-enroll__explainer'
    explainer.textContent = 'Record 15 seconds of clear speech. Your voice will be used for on-device commentary in English and Italian.'

    // Waveform visualizer
    const waveform = document.createElement('div')
    waveform.className = 'curva-voice-enroll__waveform'
    for (let i = 0; i < 32; i++) {
      const bar = document.createElement('div')
      bar.className = 'curva-voice-enroll__bar'
      waveform.appendChild(bar)
    }
    const bars = Array.from(waveform.querySelectorAll('.curva-voice-enroll__bar'))

    // Timer display
    const timerEl = document.createElement('div')
    timerEl.className = 'curva-voice-enroll__timer'
    timerEl.textContent = '0:15'

    // Record button (circle)
    const recordBtn = document.createElement('button')
    recordBtn.type = 'button'
    recordBtn.className = 'curva-voice-enroll__record'
    recordBtn.setAttribute('aria-label', 'Start recording')
    const recordDot = document.createElement('span')
    recordDot.className = 'curva-voice-enroll__record-dot'
    recordBtn.appendChild(recordDot)

    // Action buttons (shown after recording)
    const actions = document.createElement('div')
    actions.className = 'curva-voice-enroll__actions'
    actions.hidden = true

    const rerecordBtn = document.createElement('button')
    rerecordBtn.type = 'button'
    rerecordBtn.className = 'curva-voice-enroll__btn'
    rerecordBtn.textContent = 'Re-record'

    const previewBtn = document.createElement('button')
    previewBtn.type = 'button'
    previewBtn.className = 'curva-voice-enroll__btn'
    previewBtn.textContent = 'Preview'

    const saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.className = 'curva-voice-enroll__btn curva-voice-enroll__btn--primary'
    saveBtn.textContent = 'Save'

    actions.appendChild(rerecordBtn)
    actions.appendChild(previewBtn)
    actions.appendChild(saveBtn)

    // Status / error / success line
    const statusEl = document.createElement('div')
    statusEl.className = 'curva-voice-enroll__status'
    statusEl.textContent = ''

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'curva-voice-enroll__close'
    closeBtn.textContent = 'x'
    closeBtn.setAttribute('aria-label', 'close')
    closeBtn.addEventListener('click', closeModal)

    card.appendChild(closeBtn)
    card.appendChild(titleEl)
    card.appendChild(explainer)
    card.appendChild(waveform)
    card.appendChild(timerEl)
    card.appendChild(recordBtn)
    card.appendChild(actions)
    card.appendChild(statusEl)

    modalEl.appendChild(backdrop)
    modalEl.appendChild(card)
    document.body.appendChild(modalEl)

    // ESC to close
    const onKey = (e) => { if (e.key === 'Escape') closeModal() }
    document.addEventListener('keydown', onKey)

    // Track cleanup for key listener
    subs.push(() => document.removeEventListener('keydown', onKey))

    // -- Recording logic ---------------------------------------------------

    let secondsLeft = RECORD_SECONDS
    let previewAudio = null

    function setStatus(text, isError) {
      statusEl.textContent = String(text || '').slice(0, 200)
      statusEl.classList.toggle('curva-voice-enroll__status--error', !!isError)
    }

    function updateWaveform(analyser) {
      if (!analyser || !isRecording) return
      const data = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteFrequencyData(data)
      const step = Math.floor(data.length / bars.length)
      for (let i = 0; i < bars.length; i++) {
        const val = data[i * step] / 255
        // min height 4px, max 48px
        const h = Math.max(4, Math.floor(val * 48))
        bars[i].style.height = h + 'px'
      }
      waveformTimer = requestAnimationFrame(() => updateWaveform(analyser))
    }

    function resetBars() {
      if (waveformTimer) { cancelAnimationFrame(waveformTimer); waveformTimer = null }
      for (const b of bars) b.style.height = '4px'
    }

    async function startRecording() {
      setStatus('Requesting microphone...')
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      } catch (err) {
        setStatus('Microphone permission denied. Allow microphone access and try again.', true)
        return
      }

      audioCtx = new AudioContext()
      const deviceRate = audioCtx.sampleRate

      analyserNode = audioCtx.createAnalyser()
      analyserNode.fftSize = 64
      sourceNode = audioCtx.createMediaStreamSource(mediaStream)
      scriptNode = audioCtx.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1)

      pcmChunks = []
      isRecording = true

      scriptNode.addEventListener('audioprocess', (ev) => {
        if (!isRecording) return
        const raw = ev.inputBuffer.getChannelData(0)
        const chunk = downsample(new Float32Array(raw), deviceRate, TARGET_SAMPLE_RATE)
        pcmChunks.push(chunk)
      })

      sourceNode.connect(analyserNode)
      sourceNode.connect(scriptNode)
      scriptNode.connect(audioCtx.destination)

      // UI state: recording
      recordBtn.classList.add('curva-voice-enroll__record--active')
      actions.hidden = true
      secondsLeft = RECORD_SECONDS
      timerEl.textContent = '0:' + String(secondsLeft).padStart(2, '0')
      setStatus('Recording...')

      updateWaveform(analyserNode)

      countdownTimer = setInterval(() => {
        secondsLeft -= 1
        timerEl.textContent = '0:' + String(Math.max(0, secondsLeft)).padStart(2, '0')
        if (secondsLeft <= 0) {
          clearInterval(countdownTimer)
          countdownTimer = null
          finishRecording()
        }
      }, 1000)
    }

    function finishRecording() {
      if (!isRecording) return
      isRecording = false

      // Stop capture but keep audioCtx alive briefly for the script processor
      // to drain. Close on next tick.
      if (scriptNode) { try { scriptNode.disconnect() } catch { /* noop */ } scriptNode = null }
      if (sourceNode) { try { sourceNode.disconnect() } catch { /* noop */ } sourceNode = null }
      if (analyserNode) { try { analyserNode.disconnect() } catch { /* noop */ } analyserNode = null }
      if (mediaStream) {
        try { mediaStream.getTracks().forEach((t) => t.stop()) } catch { /* noop */ }
        mediaStream = null
      }
      setTimeout(() => {
        if (audioCtx) { try { audioCtx.close() } catch { /* noop */ } audioCtx = null }
      }, 100)

      resetBars()
      recordBtn.classList.remove('curva-voice-enroll__record--active')

      recordedPcm = flattenPcm(pcmChunks)
      pcmChunks = []
      recordedBlob = pcmToWavBlob(recordedPcm, TARGET_SAMPLE_RATE)

      timerEl.textContent = '0:15'
      actions.hidden = false
      setStatus('Recording complete. Preview or save to enroll.')
    }

    recordBtn.addEventListener('click', () => {
      if (isRecording) {
        clearInterval(countdownTimer)
        countdownTimer = null
        finishRecording()
      } else if (!recordedPcm) {
        startRecording()
      }
    })

    rerecordBtn.addEventListener('click', () => {
      recordedPcm = null
      recordedBlob = null
      if (previewAudio) { try { previewAudio.pause(); previewAudio.src = '' } catch { /* noop */ } previewAudio = null }
      actions.hidden = true
      timerEl.textContent = '0:15'
      setStatus('')
    })

    previewBtn.addEventListener('click', () => {
      if (!recordedBlob) return
      if (previewAudio) { try { previewAudio.pause() } catch { /* noop */ } }
      const url = URL.createObjectURL(recordedBlob)
      previewAudio = new Audio(url)
      const p = previewAudio.play()
      if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay policy; noop */ })
      previewAudio.addEventListener('ended', () => {
        URL.revokeObjectURL(url)
      })
    })

    saveBtn.addEventListener('click', async () => {
      if (!recordedPcm) return
      saveBtn.disabled = true
      saveBtn.textContent = 'Enrolling...'
      setStatus('')
      try {
        // Preload boundary at preload.js:1510 rejects Float32Array with
        // "unsupported pcm type" — it only accepts ArrayBuffer / Uint8Array /
        // Buffer / string-path. Additionally Chatterbox expects a WAV-encoded
        // container, not raw PCM samples. Encode the 16 kHz mono Float32 PCM
        // as a 16-bit little-endian WAV file here, then pass the WAV bytes as
        // a Uint8Array so preload accepts it and bare/voiceClone.js Hyperblob-
        // stores a valid WAV that Chatterbox can consume.
        const wavBytes = float32PcmToWav16Bit(recordedPcm, TARGET_SAMPLE_RATE)
        await curva.voiceClone.enroll(wavBytes)
        // Success state
        card.textContent = ''
        const successTitle = document.createElement('div')
        successTitle.className = 'curva-voice-enroll__title'
        successTitle.textContent = 'Voice cloned.'
        const successMsg = document.createElement('p')
        successMsg.className = 'curva-voice-enroll__explainer'
        successMsg.textContent = 'Try it now with a chat message.'
        const doneBtn = document.createElement('button')
        doneBtn.type = 'button'
        doneBtn.className = 'curva-voice-enroll__btn curva-voice-enroll__btn--primary'
        doneBtn.textContent = 'Close'
        doneBtn.addEventListener('click', closeModal)
        card.appendChild(successTitle)
        card.appendChild(successMsg)
        card.appendChild(doneBtn)
      } catch (err) {
        saveBtn.disabled = false
        saveBtn.textContent = 'Save'
        setStatus('Enrollment failed: ' + (err?.message || 'unknown'), true)
      }
    })

    // Wire bare events if present
    if (typeof curva.voiceClone.onEnrolled === 'function') {
      const off = curva.voiceClone.onEnrolled(() => {
        setStatus('Enrolled.')
        off()
      })
    }
    if (typeof curva.voiceClone.onError === 'function') {
      const off = curva.voiceClone.onError((payload) => {
        setStatus('Error: ' + (payload?.message || 'unknown'), true)
        saveBtn.disabled = false
        saveBtn.textContent = 'Save'
      })
      subs.push(off)
    }
  }

  function closeModal() {
    if (isRecording) {
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null }
      stopCapture()
    }
    if (modalEl) { try { modalEl.remove() } catch { /* noop */ } modalEl = null }
    recordedPcm = null
    recordedBlob = null
    pcmChunks = []
  }

  // Return the open function so RoomHeader can trigger it
  return { open: openModal, destroy }
}
