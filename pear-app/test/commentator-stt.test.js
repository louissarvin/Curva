// Wave 14 brittle tests: QVAC Whisper streaming captions.
//
// The commentator STT surface is exercised WITHOUT downloading a 74 MB
// Whisper model or touching the SDK's DHT. All three tests inject a fake SDK
// (`sdkImpl`) whose `transcribeStream()` returns a hand-rolled session whose
// iteration yields deterministic events. The docs surface being exercised is
// documented in bare/commentator.js (transcribe.d.ts overload 4 -> Promise<
// TranscribeStreamSession>).

const test = require('brittle')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const {
  createCommentator,
  isValidSystemCaption,
  buildCaptionMessage,
  bufferFrameSource,
  wavFileFrameSource,
  sttFlagEnabled,
  STT_FRAME_BYTES,
  STT_FRAME_SAMPLES
} = require('../bare/commentator.js')

// -- helpers ---------------------------------------------------------------

function makeChatSpy () {
  const sent = []
  return {
    sent,
    sendSystem: async (msg) => { sent.push(msg); return true },
    onGoalCluster: null
  }
}

function makeFakeSession (events) {
  const writes = []
  let ended = false
  const iter = (async function * () {
    for (const ev of events) {
      // Yield to microtask queue so producer + consumer interleave.
      await Promise.resolve()
      yield ev
    }
  })()
  return {
    writes,
    isEnded: () => ended,
    write: async (chunk) => { writes.push(chunk) },
    end: async () => { ended = true },
    [Symbol.asyncIterator]: () => iter
  }
}

function makeFakeSdk ({ session, modelIdBase = 'test-stt' } = {}) {
  const loadCalls = []
  const streamCalls = []
  return {
    loadCalls,
    streamCalls,
    // Registry constants pretend to be plain strings, matching the real SDK.
    WHISPER_TINY: 'REGISTRY::WHISPER_TINY',
    VAD_SILERO_5_1_2: 'REGISTRY::VAD_SILERO_5_1_2',
    loadModel: async (opts) => {
      loadCalls.push(opts)
      return `${modelIdBase}::${loadCalls.length}`
    },
    transcribeStream: async (opts) => {
      streamCalls.push(opts)
      return session
    }
  }
}

async function makeTmpStorageDir () {
  const dir = path.join(os.tmpdir(), `curva-stt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ } }
  }
}

async function drain (commentator) {
  // Wait for both loops to finish. `sttState` promises are exposed via
  // _internal for exactly this reason.
  const { sttState } = commentator._internal
  if (sttState.feedPromise) { try { await sttState.feedPromise } catch { /* noop */ } }
  if (sttState.consumePromise) { try { await sttState.consumePromise } catch { /* noop */ } }
}

// -- 1. Feature flag gate --------------------------------------------------

test('enableSTT is a no-op when CURVA_QVAC_STT_ENABLED is not set', async (t) => {
  const prev = process.env.CURVA_QVAC_STT_ENABLED
  delete process.env.CURVA_QVAC_STT_ENABLED
  const { dir, cleanup } = await makeTmpStorageDir()
  const chat = makeChatSpy()
  const events = []
  const commentator = createCommentator({
    storageDir: dir,
    isHost: true,
    chat,
    getMatchTimeMs: () => 0,
    emit: (name, payload) => events.push({ name, payload })
  })

  const sdk = makeFakeSdk({ session: makeFakeSession([]) })
  const res = await commentator.enableSTT({
    audioSource: bufferFrameSource(new Uint8Array(STT_FRAME_BYTES * 2)),
    sdkImpl: sdk
  })

  t.is(res.enabled, false, 'STT stays disabled when flag is off')
  t.is(res.reason, 'FLAG_OFF', 'reason surfaced')
  t.is(sdk.loadCalls.length, 0, 'no loadModel call when flag is off')
  t.is(sdk.streamCalls.length, 0, 'no transcribeStream call when flag is off')
  t.is(chat.sent.length, 0, 'no chat.sendSystem call when flag is off')
  t.ok(events.some((e) => e.name === 'caption:disabled' && e.payload?.reason === 'FLAG_OFF'), 'disabled event fired')
  t.is(sttFlagEnabled(), false, 'sttFlagEnabled reports false')

  await commentator.close()
  if (prev !== undefined) process.env.CURVA_QVAC_STT_ENABLED = prev
  cleanup()
})

test('enableSTT gates on the host flag: guests cannot enable', async (t) => {
  process.env.CURVA_QVAC_STT_ENABLED = 'true'
  const { dir, cleanup } = await makeTmpStorageDir()
  const chat = makeChatSpy()
  const commentator = createCommentator({
    storageDir: dir,
    isHost: false,
    chat,
    getMatchTimeMs: () => 0
  })
  await t.exception(async () => {
    await commentator.enableSTT({
      audioSource: bufferFrameSource(new Uint8Array(STT_FRAME_BYTES)),
      sdkImpl: makeFakeSdk({ session: makeFakeSession([]) })
    })
  }, /only host/i, 'guest caller rejected')
  delete process.env.CURVA_QVAC_STT_ENABLED
  await commentator.close()
  cleanup()
})

// -- 2. WAV fallback loop frames correctly ---------------------------------

test('WAV fallback loop chunks the buffer into 30ms f32le frames', async (t) => {
  process.env.CURVA_QVAC_STT_ENABLED = 'true'
  const { dir, cleanup } = await makeTmpStorageDir()

  // Build a synthetic canonical-header WAV: 44 header bytes + N frames of data.
  const frameCount = 7
  const dataBytes = frameCount * STT_FRAME_BYTES
  // Add a partial 5-byte tail that MUST be dropped by the loop.
  const wavBytes = new Uint8Array(44 + dataBytes + 5)
  // Fill data with an ascending pattern so we can verify frame boundaries.
  for (let i = 0; i < dataBytes; i++) wavBytes[44 + i] = (i & 0xff)
  const wavPath = path.join(dir, 'test.wav')
  fs.writeFileSync(wavPath, wavBytes)

  const emitted = []
  // The session yields NO text events, so the consumer completes immediately
  // once we call end(). This lets us assert what the producer wrote.
  const session = makeFakeSession([])
  const sdk = makeFakeSdk({ session })

  const chat = makeChatSpy()
  const commentator = createCommentator({
    storageDir: dir,
    isHost: true,
    chat,
    getMatchTimeMs: () => 42_000,
    emit: (name, payload) => emitted.push({ name, payload })
  })

  const res = await commentator.enableSTT({
    audioSource: wavFileFrameSource(wavPath, { intervalMs: 0 }),
    sdkImpl: sdk,
    lang: 'it'
  })
  t.is(res.enabled, true, 'STT enabled')
  t.is(res.sourceKind, 'injected', 'audio source honored')
  await drain(commentator)

  t.is(session.writes.length, frameCount, 'exactly 7 frames written (partial tail dropped)')
  for (let i = 0; i < frameCount; i++) {
    t.is(session.writes[i].byteLength, STT_FRAME_BYTES, `frame ${i} is ${STT_FRAME_BYTES} bytes`)
    // First byte of each frame corresponds to the ascending pattern.
    const expectedFirstByte = (i * STT_FRAME_BYTES) & 0xff
    t.is(session.writes[i][0], expectedFirstByte, `frame ${i} boundary aligned`)
  }
  t.is(STT_FRAME_SAMPLES, 480, '30ms at 16kHz => 480 samples')
  t.is(STT_FRAME_BYTES, 1920, '480 samples f32le => 1920 bytes')

  // Load config assertions.
  t.is(sdk.loadCalls.length, 1, 'loadModel called once')
  const loadOpts = sdk.loadCalls[0]
  t.is(loadOpts.modelType, 'whisper', 'whisper modelType')
  t.is(loadOpts.modelSrc, 'REGISTRY::WHISPER_TINY', 'WHISPER_TINY constant resolved')
  t.is(loadOpts.modelConfig.language, 'it', 'lang propagated to modelConfig')
  t.is(loadOpts.modelConfig.audio_format, 'f32le', 'f32le per voice-assistant docs')
  t.is(loadOpts.modelConfig.vadModelSrc, 'REGISTRY::VAD_SILERO_5_1_2', 'Silero VAD wired')
  t.is(loadOpts.modelConfig.vad_params.threshold, 0.6, 'VAD threshold matches docs')
  t.is(loadOpts.modelConfig.vad_params.min_silence_duration_ms, 700, 'min silence matches docs')
  t.is(loadOpts.modelConfig.vad_params.speech_pad_ms, 200, 'speech pad matches docs')

  await commentator.close()
  delete process.env.CURVA_QVAC_STT_ENABLED
  cleanup()
})

// -- 3. Autobase caption message shape --------------------------------------

test('text events produce well-formed system:caption messages', async (t) => {
  process.env.CURVA_QVAC_STT_ENABLED = 'true'
  const { dir, cleanup } = await makeTmpStorageDir()
  const chat = makeChatSpy()
  const emitted = []

  const events = [
    { type: 'vad', speaking: true, probability: 0.82 },
    { type: 'text', text: '  Italia attacca sulla fascia ' },
    { type: 'endOfTurn', source: 'whisper', silenceDurationMs: 720 },
    { type: 'text', text: 'GOL DI CHIESA!' },
    // Empty text must NOT produce a chat message.
    { type: 'text', text: '   ' }
  ]
  const session = makeFakeSession(events)
  const sdk = makeFakeSdk({ session })

  let matchTime = 900_000
  const commentator = createCommentator({
    storageDir: dir,
    isHost: true,
    chat,
    getMatchTimeMs: () => matchTime,
    emit: (name, payload) => emitted.push({ name, payload }),
    now: () => 1_700_000_000_000
  })

  const res = await commentator.enableSTT({
    audioSource: bufferFrameSource(new Uint8Array(STT_FRAME_BYTES * 2)),
    sdkImpl: sdk,
    lang: 'it'
  })
  t.is(res.enabled, true, 'STT enabled')
  await drain(commentator)

  t.is(chat.sent.length, 2, 'two non-empty text events => two chat messages (empty text skipped)')
  for (const msg of chat.sent) {
    t.ok(isValidSystemCaption(msg), 'shape validator accepts message')
    t.is(msg.type, 'system:caption', 'type field pinned')
    t.is(msg.lang, 'it', 'lang propagated')
    t.is(msg.matchTimeMs, 900_000, 'matchTimeMs sourced from getMatchTimeMs')
    t.is(msg.source, 'stt', 'source pinned to stt')
    t.is(msg.wall_clock_ms, 1_700_000_000_000, 'wall_clock_ms stamped from now()')
    t.ok(msg.text.length > 0 && msg.text.length <= 280, 'text within cap')
  }
  t.is(chat.sent[0].text, 'Italia attacca sulla fascia', 'first caption trimmed')
  t.is(chat.sent[1].text, 'GOL DI CHIESA!', 'second caption emitted verbatim')

  // Event bus signals we care about are all present.
  t.ok(emitted.some((e) => e.name === 'caption:ready'), 'caption:ready fired')
  t.ok(emitted.some((e) => e.name === 'caption:emitted' && e.payload?.text?.includes('Italia')), 'caption:emitted mirrors text')
  t.ok(emitted.some((e) => e.name === 'caption:vad' && e.payload?.speaking === true), 'caption:vad forwarded')
  t.ok(emitted.some((e) => e.name === 'caption:endOfTurn' && e.payload?.source === 'whisper'), 'caption:endOfTurn forwarded')

  await commentator.close()
  delete process.env.CURVA_QVAC_STT_ENABLED
  cleanup()
})

// -- 4. Pure helper: buildCaptionMessage ------------------------------------

test('buildCaptionMessage rejects non-string text and caps lang length', async (t) => {
  // brittle's t.exception only catches Error-derived instances; TypeError
  // subclass is rethrown unless we opt into `.all`. See feedback memory
  // brittle_exception_all.
  t.exception.all(() => buildCaptionMessage({ text: null, lang: 'en', matchTimeMs: 0 }), /text required/, 'null text rejected')
  const msg = buildCaptionMessage({
    text: 'hello',
    lang: 'italianx-extra-long',
    matchTimeMs: -50,
    now: () => 1_000
  })
  t.is(msg.type, 'system:caption')
  t.is(msg.lang.length <= 8, true, 'lang capped')
  t.is(msg.matchTimeMs, 0, 'negative matchTimeMs clamped to 0')
  t.is(msg.wall_clock_ms, 1_000)
  t.is(msg.source, 'stt', 'default source is stt')
  t.ok(isValidSystemCaption(msg), 'shape passes validator')
})

test('isValidSystemCaption rejects malformed shapes', async (t) => {
  t.absent(isValidSystemCaption(null), 'null rejected')
  t.absent(isValidSystemCaption({}), 'empty rejected')
  t.absent(isValidSystemCaption({ type: 'system:caption', text: '', lang: 'en', matchTimeMs: 0 }), 'empty text rejected')
  t.absent(isValidSystemCaption({ type: 'system:caption', text: 'ok', lang: '', matchTimeMs: 0 }), 'empty lang rejected')
  t.absent(isValidSystemCaption({ type: 'system:caption', text: 'ok', lang: 'en', matchTimeMs: -1 }), 'negative time rejected')
  t.ok(isValidSystemCaption({ type: 'system:caption', text: 'ok', lang: 'en', matchTimeMs: 0 }), 'minimal shape accepted')
})
