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
// Chatterbox voice-clone requires strictly MORE than 5 s of reference audio
// (verified from the tts-ggml addon runtime error:
// "--reference-audio is only N.NN s; Chatterbox requires strictly more than
//  5 s of clean mono speech. Shorter references produce undersized
//  conditioning tensors and the model falls back on the built-in voice.").
// We enforce a 6-second minimum with 1-second safety margin so users don't
// hit the exact-boundary rejection at 5.00-5.03 s.
const MIN_RECORD_SECONDS = 6
const TARGET_SAMPLE_RATE = 16_000
// Minimum PCM sample count required to satisfy Chatterbox validation.
const MIN_RECORD_SAMPLES = MIN_RECORD_SECONDS * TARGET_SAMPLE_RATE
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
        // Guard against stopping short of Chatterbox's >5 s minimum. If we
        // stop early, the reference WAV is under 5 s and the tts-ggml addon
        // rejects it at model activation time with a
        // FAILED_TO_ACTIVATE / "Chatterbox requires strictly more than 5 s"
        // error that only surfaces on the first sample chip click, well
        // after the user has moved past enrollment.
        const soFarSamples = pcmChunks.reduce((sum, c) => sum + (c.length || 0), 0)
        if (soFarSamples < MIN_RECORD_SAMPLES) {
          const soFarSec = soFarSamples / TARGET_SAMPLE_RATE
          const need = Math.max(1, Math.ceil(MIN_RECORD_SECONDS - soFarSec))
          setStatus('Keep recording ' + need + ' more second' + (need === 1 ? '' : 's') + ' — Chatterbox needs at least ' + MIN_RECORD_SECONDS + 's of clean speech.')
          return
        }
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
      // Defensive: block Save if the recording is under Chatterbox's 5s minimum.
      // Should never fire because recordBtn already guards early stop, but
      // catches any exotic path that leaves a short pcm buffer here.
      if (recordedPcm.length < MIN_RECORD_SAMPLES) {
        const soFarSec = (recordedPcm.length / TARGET_SAMPLE_RATE).toFixed(2)
        setStatus('Recording is only ' + soFarSec + 's — Chatterbox needs at least ' + MIN_RECORD_SECONDS + 's. Please re-record.', true)
        return
      }
      saveBtn.disabled = true
      saveBtn.textContent = 'Enrolling...'
      // On a fresh cold boot the worker has to lazy-import @qvac/sdk and stand
      // up a dedicated Hyperblobs on a new corestore namespace before it can
      // accept the WAV. That first-call cost can push past 10 seconds. Surface
      // a status so the user knows the app isn't hung.
      setStatus('Writing reference audio to the P2P mesh...')
      try {
        // Preload boundary at preload.js:1510 rejects Float32Array with
        // "unsupported pcm type" — it only accepts ArrayBuffer / Uint8Array /
        // Buffer / string-path. Additionally Chatterbox expects a WAV-encoded
        // container, not raw PCM samples. Encode the 16 kHz mono Float32 PCM
        // as a 16-bit little-endian WAV file here, then pass the WAV bytes as
        // a Uint8Array so preload accepts it and bare/voiceClone.js Hyperblob-
        // stores a valid WAV that Chatterbox can consume.
        const wavBytes = float32PcmToWav16Bit(recordedPcm, TARGET_SAMPLE_RATE)
        // Worker ack shape (workers/main.js:5445): { ok, ref, requestId }.
        // If ok=false the worker already emitted `voiceClone:error` with a
        // typed code; the promise still RESOLVES rather than rejecting. Check
        // ok before advancing to the success UI or the modal locks into the
        // "Voice cloned" state with a null referenceRef and every subsequent
        // sample chip click silently fails.
        const out = await curva.voiceClone.enroll(wavBytes)
        if (!out || out.ok === false) {
          const code = out?.code || 'UNKNOWN'
          throw new Error('enrollment failed (' + code + ')')
        }
        // Success state
        card.textContent = ''
        const successTitle = document.createElement('div')
        successTitle.className = 'curva-voice-enroll__title'
        successTitle.textContent = 'Voice cloned.'
        const successMsg = document.createElement('p')
        successMsg.className = 'curva-voice-enroll__explainer'
        successMsg.textContent = 'Your voice is now on the P2P mesh. When a goal fires, every peer hears the announcement in this voice, in their own language. Play a sample below to hear yourself in each language you support.'
        card.appendChild(successTitle)
        card.appendChild(successMsg)

        // Language chips -> pipe a fixed sample sentence through
        // curva.voiceClone.speak(text, locale). Chatterbox supported locales
        // per @qvac/sdk/dist/schemas/text-to-speech.d.ts:2 TTS_CHATTERBOX_LANGUAGES
        // are `en, it, es, fr, de, pt`. See bare/voiceClone.js:344.
        //
        // Playback uses the standard WebAudio path: the SDK returns raw Float32
        // samples + sampleRate on speak-done, we shove them into an
        // AudioBuffer and start(). This is the same "aha" moment that closes
        // the F1 voice-clone story in the demo.
        const SAMPLES = [
          { code: 'en', label: 'EN English',  text: 'Goal! What a strike from midfield, the crowd is on their feet!' },
          { code: 'it', label: 'IT Italiano', text: 'Gol! Che tiro da centrocampo, la folla è in piedi!' },
          { code: 'es', label: 'ES Espanol',  text: 'Gol! Que gran disparo desde el centro del campo, la aficion esta en pie!' },
          { code: 'fr', label: 'FR Francais', text: 'But! Quelle frappe depuis le milieu de terrain, la foule est debout!' },
          { code: 'de', label: 'DE Deutsch',  text: 'Tor! Was fuer ein Schuss aus dem Mittelfeld, die Menge steht auf den Beinen!' },
          { code: 'pt', label: 'PT Portugues', text: 'Gol! Que chutaco do meio-campo, a torcida esta de pe!' }
        ]

        const sampleTitle = document.createElement('div')
        sampleTitle.className = 'curva-voice-enroll__hint'
        sampleTitle.textContent = 'Play a sample in:'
        sampleTitle.style.marginTop = '18px'
        card.appendChild(sampleTitle)

        const chipRow = document.createElement('div')
        chipRow.className = 'curva-voice-enroll__actions'
        chipRow.style.flexWrap = 'wrap'
        chipRow.style.marginTop = '10px'
        card.appendChild(chipRow)

        const sampleStatus = document.createElement('div')
        sampleStatus.className = 'curva-voice-enroll__status'
        sampleStatus.textContent = ''
        card.appendChild(sampleStatus)

        function playSamples (rawSamples, sampleRate) {
          try {
            // Chatterbox emits Int16Array of 24 kHz PCM (verified in
            // node_modules/@qvac/tts-ggml/index.js:215 which documents
            // "outputArray = Int16Array of 24 kHz PCM samples"). Over the
            // Bare worker IPC pipe those samples are JSON-serialised into a
            // plain number[] where each entry is a signed 16-bit integer
            // (range -32768..32767). WebAudio's copyToChannel requires
            // Float32 in [-1.0, 1.0], so we normalise by dividing through
            // 32768 (the max magnitude of int16). This path is unconditional
            // for Array inputs because Chatterbox always yields int16 - a
            // "smart" sniff on the first N samples was too fragile (short
            // clips can start with near-silent samples and false-negative
            // the int16 detection, leaving the buffer at full int16 scale
            // which WebAudio treats as +32000 = clip-to-1.0 = distortion
            // or silence depending on the platform).
            let arr
            if (rawSamples instanceof Float32Array) {
              arr = rawSamples
            } else if (rawSamples instanceof Int16Array) {
              arr = new Float32Array(rawSamples.length)
              for (let i = 0; i < rawSamples.length; i++) arr[i] = rawSamples[i] / 32768
            } else if (Array.isArray(rawSamples)) {
              arr = new Float32Array(rawSamples.length)
              for (let i = 0; i < rawSamples.length; i++) arr[i] = rawSamples[i] / 32768
            } else if (rawSamples && rawSamples.buffer) {
              // TypedArray view - assume int16 semantics and reinterpret.
              const view = new Int16Array(rawSamples.buffer, rawSamples.byteOffset || 0, rawSamples.byteLength / 2)
              arr = new Float32Array(view.length)
              for (let i = 0; i < view.length; i++) arr[i] = view[i] / 32768
            } else {
              console.warn('[Curva] playSamples: unrecognised input shape', typeof rawSamples, rawSamples && rawSamples.constructor && rawSamples.constructor.name)
              return false
            }
            if (!arr.length) return false
            // Range sanity for debugging - log peak/rms so we can tell from
            // the DevTools console whether the audio is truly quiet vs. clipped.
            let peak = 0
            let rms = 0
            for (let i = 0; i < arr.length; i++) {
              const v = arr[i]
              if (v > peak) peak = v; else if (-v > peak) peak = -v
              rms += v * v
            }
            rms = Math.sqrt(rms / arr.length)
            console.info('[Curva] playSamples', { samples: arr.length, sampleRate, peak: peak.toFixed(4), rms: rms.toFixed(4) })

            const ACtor = window.AudioContext || window.webkitAudioContext
            if (!ACtor) return false
            const ac = new ACtor({ sampleRate: Number(sampleRate) || 24000 })
            // Some platforms (Safari, iOS, and Chromium on macOS in certain
            // states) suspend a fresh AudioContext until an explicit resume().
            // The chip click was a user gesture but 30-45s of synthesis can
            // elapse before we get here; kick resume() to be safe. Ignored
            // (returns a resolved Promise) on platforms where the context is
            // already running.
            if (typeof ac.resume === 'function') { ac.resume().catch(() => {}) }
            const buf = ac.createBuffer(1, arr.length, Number(sampleRate) || 24000)
            buf.copyToChannel(arr, 0, 0)
            const src = ac.createBufferSource()
            src.buffer = buf
            src.connect(ac.destination)
            src.onended = () => { try { ac.close() } catch { /* noop */ } }
            src.start(0)
            return true
          } catch { return false }
        }

        // Subscribe to voiceClone speak-done ONCE for this success state so we
        // can play back the Float32 samples returned by the bare worker.
        if (typeof curva.voiceClone.onSpeakDone === 'function') {
          const off = curva.voiceClone.onSpeakDone((payload) => {
            if (!payload) return
            const played = playSamples(payload.samples, payload.sampleRate)
            sampleStatus.textContent = played
              ? 'Playing sample (' + (payload.locale || '?') + ')'
              : 'Sample returned but audio playback failed'
          })
          subs.push(off)
        }

        for (const s of SAMPLES) {
          const chip = document.createElement('button')
          chip.type = 'button'
          chip.className = 'curva-voice-enroll__btn'
          chip.textContent = s.label
          chip.addEventListener('click', async () => {
            if (typeof curva.voiceClone.speak !== 'function') {
              sampleStatus.textContent = 'Voice-clone playback unavailable'
              return
            }
            chip.disabled = true
            sampleStatus.textContent = 'Loading ' + s.label + ' voice model (first use of this locale can take ~30-45s on CPU)...'
            const t0 = Date.now()
            try {
              const out = await curva.voiceClone.speak(s.text, s.code)
              const dt = ((Date.now() - t0) / 1000).toFixed(1)
              if (!out || out.ok === false) {
                sampleStatus.textContent = 'Sample failed for ' + s.label + ': ' + (out?.code || 'unknown')
              } else {
                // Success: the worker ack tells us how many samples got synthesized
                // and at what sample rate. onSpeakDone (subscribed above) may fire
                // BEFORE this ack lands (both traverse the same IPC pipe in send
                // order: speak-done, then ack). If it already replaced the status
                // to "Playing sample (locale)", we don't clobber it. Otherwise
                // surface the synthesis stats so the user isn't left staring at
                // "Loading...".
                if (sampleStatus.textContent.startsWith('Loading ')) {
                  const secs = out.sampleCount && out.sampleRate
                    ? (out.sampleCount / out.sampleRate).toFixed(2) + 's'
                    : ''
                  sampleStatus.textContent = 'Synthesized ' + secs + ' of ' + s.label + ' audio in ' + dt + 's (waiting for playback)'
                }
              }
            } catch (err) {
              sampleStatus.textContent = 'Sample failed for ' + s.label + ': ' + (err?.message || 'unknown')
            } finally {
              chip.disabled = false
            }
          })
          chipRow.appendChild(chip)
        }

        const doneBtn = document.createElement('button')
        doneBtn.type = 'button'
        doneBtn.className = 'curva-voice-enroll__btn curva-voice-enroll__btn--primary'
        doneBtn.textContent = 'Close'
        doneBtn.style.marginTop = '18px'
        doneBtn.addEventListener('click', closeModal)
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
