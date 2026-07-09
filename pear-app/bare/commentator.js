// Curva QVAC LLM Room Commentator (Wave 13A).
//
// Docs-verification memo -----------------------------------------------------
//
// Source of truth for the completion API is the @qvac/sdk installed at
// pear-app/node_modules/@qvac/sdk (v0.14.0). The docs quickstart advertises:
//   import { loadModel, completion, unloadModel, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/sdk'
//   const modelId = await loadModel({ modelSrc, onProgress })
//   const result = completion({ modelId, history, stream: true })
//   for await (const token of result.tokenStream) { ... }
//   await unloadModel({ modelId })
//
// Installed reality matches: `dist/index.js` re-exports `completion`,
// `loadModel`, `unloadModel` (and 40+ other helpers). The bare-runtime plugin
// bundle exposes `llmPlugin` at `@qvac/sdk/llamacpp-completion/plugin` — the
// worker.js served by @qvac/sdk already wires that plugin so consumers on the
// Bare side only need the top-level named exports (same as our translate.js
// binding pattern in bare/translate.js).
//
// Model choice: QWEN3_600M_INST_Q4 (Qwen3 0.6B instruct, q4).
//   - expectedSize: 382,156,480 bytes ≈ 364 MB on disk (per
//     node_modules/@qvac/sdk/dist/models/registry/models.js:2079).
//   - Smallest chat-tuned model in the installed SDK registry (Llama 3.2 1B
//     Q4 is 773 MB, Qwen3 1.7B is 1 GB, Qwen3 4B is 2.5 GB+). 600M fits our
//     "sub-1B parameter" preference from the design brief.
//   - Runtime memory footprint at inference is roughly model_size + KV cache
//     ≈ 500-700 MB on a laptop CPU. Well within a two-peer watch-party demo
//     laptop, but STILL a heavy first-time download — hence the explicit
//     enable toggle in the renderer (see COMMENTATOR_MODEL_SIZE_MB below).
//   - Quantization q4 keeps latency at ~10-25 tokens/s on Apple Silicon CPU;
//     more than fast enough for a <30 word color-commentary line.
//
// Prompt template comes from the Wave 13A brief. Kept as a template string
// with `{placeholder}` slots so tests can assert the exact template shape.
//
// Fallback: if the SDK LLM plugin is unavailable at boot (older SDK, dev
// harness without the plugin binary, tests using an injected sdkImpl:null) we
// stay in a disabled state and emit nothing. The room never breaks because of
// commentary — same resilience posture as translate.js.
//
// Feature flag: CURVA_QVAC_COMMENTATOR_ENABLED (default 'false'). Even when
// enabled, the model does NOT auto-download; the host must click the "Enable
// commentator (downloads ~364MB one time)" toggle in the renderer.

// Dual-runtime module resolution (see bare/clips.js for the rationale).
const path = (() => {
  try { return require('bare-path') } catch { return require('path') }
})()
const fs = (() => {
  try { return require('bare-fs') } catch { return require('fs') }
})()

const translateModule = require('./translate.js')
const { loadSdkLlm } = translateModule
// Reuse the same streaming-safe SHA-256 helper the translator uses for model
// integrity verification (Fix Wave C, T4). Avoids a second implementation and
// keeps the digest surface identical between NMT and STT model loads.
const sha256Sync = translateModule?._internal?.sha256Sync

// Model registry name from @qvac/sdk. Kept as a plain string so callers can
// pass any of the SDK's registry entries (e.g. `LLAMA_3_2_1B_INST_Q4_0`) via
// an override for larger deployments.
const DEFAULT_MODEL_SRC = 'QWEN3_600M_INST_Q4'
const DEFAULT_MODEL_SIZE_MB = 364

// Trigger cadence knobs. Per brief.
const DEFAULT_TICK_MS = 60_000           // one commentary every 60s of playback
const DEFAULT_RATE_LIMIT_MS = 30_000     // never emit more than 1 per 30s
const DEFAULT_SEEK_JUMP_MS = 10_000      // skip commentary if forward-seek >10s
const DEFAULT_MAX_WORDS = 30
const DEFAULT_TONE = 'italian-ultras'

const TONE_PROMPTS = {
  'italian-ultras': 'the tone of an Italian ultras announcer',
  'calm-analyst': 'the tone of a calm, tactical football analyst',
  'hype': 'the tone of a hype-driven American sports broadcaster'
}

const PROMPT_TEMPLATE = [
  'You are the color commentator for a friendly two-peer World Cup watch party.',
  'Match: {matchTitle}',
  'Match time: {matchTimeSeconds}s',
  'Recent chat (last 5 messages): {chatContext}',
  'Recent playhead event: {playheadType} at {matchTimeSeconds}s',
  '',
  'Produce ONE short line of color commentary in {toneLine}.',
  'Under {maxWords} words. Football-specific. Never generic.'
].join('\n')

function buildPrompt ({ matchTitle, matchTimeSeconds, chatContext, playheadType, tone, maxWords }) {
  const toneKey = TONE_PROMPTS[tone] ? tone : DEFAULT_TONE
  return PROMPT_TEMPLATE
    .replace('{matchTitle}', String(matchTitle || 'unknown match'))
    .replace(/\{matchTimeSeconds\}/g, String(Math.max(0, Math.floor(Number(matchTimeSeconds) || 0))))
    .replace('{chatContext}', formatChatContext(chatContext))
    .replace('{playheadType}', String(playheadType || 'tick'))
    .replace('{toneLine}', TONE_PROMPTS[toneKey])
    .replace('{maxWords}', String(Math.max(5, Math.min(60, Number(maxWords) || DEFAULT_MAX_WORDS))))
}

function formatChatContext (msgs) {
  if (!Array.isArray(msgs) || msgs.length === 0) return '(none)'
  return msgs
    .slice(-5)
    .map((m) => {
      const who = typeof m?.handle === 'string' && m.handle.length > 0
        ? m.handle.slice(0, 24)
        : (typeof m?.by_peer === 'string' ? m.by_peer.slice(0, 8) : 'anon')
      const text = typeof m?.text === 'string' ? m.text.slice(0, 120) : ''
      return `${who}: ${text}`
    })
    .join(' | ')
}

/**
 * Sanitise LLM output before it hits chat.
 * - Strip control chars (defence-in-depth; Chat.js textContent already blocks XSS)
 * - Collapse whitespace / newlines to spaces
 * - Trim; trim outer quotes an LLM often adds
 * - Cap to maxWords words
 */
function sanitizeCommentary (raw, maxWords = DEFAULT_MAX_WORDS) {
  if (typeof raw !== 'string') return ''
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0)
    if (code === 0x0A || code === 0x0D || code === 0x09) { out += ' '; continue }
    if (code < 0x20) continue
    if (code >= 0x80 && code <= 0x9F) continue
    if (code === 0xFEFF) continue
    out += ch
  }
  out = out.replace(/\s+/g, ' ').trim()
  // Strip a single wrapping quote pair the LLM likes to add.
  if (out.length >= 2) {
    const first = out.charAt(0)
    const last = out.charAt(out.length - 1)
    if ((first === '"' && last === '"') || (first === '“' && last === '”') ||
        (first === '\'' && last === '\'')) {
      out = out.slice(1, -1).trim()
    }
  }
  const words = out.split(' ').filter(Boolean)
  const cap = Math.max(5, Math.min(60, Number(maxWords) || DEFAULT_MAX_WORDS))
  if (words.length > cap) out = words.slice(0, cap).join(' ')
  // Hard char cap: chat validator allows up to 280.
  if (out.length > 280) out = out.slice(0, 280)
  return out
}

// -----------------------------------------------------------------------------
// Wave 14 STT (Whisper streaming) additions.
//
// Docs-verification memo -----------------------------------------------------
//
// Source of truth is the installed @qvac/sdk .d.ts:
//   pear-app/node_modules/@qvac/sdk/dist/client/api/transcribe.d.ts
// The bidirectional overload returns Promise<TranscribeStreamSession> where
// session.write(Uint8Array) feeds f32le PCM at 16 kHz and iteration yields
// discriminated events:
//   { type: 'text', text }
//   { type: 'segment', segment }
//   { type: 'vad', speaking, probability }        // whisper only
//   { type: 'endOfTurn', source, silenceDurationMs? }
// Verified against https://docs.qvac.tether.io/ai-capabilities/transcription/
// on 2026-07-05.
//
// VAD reference config comes from
// https://docs.qvac.tether.io/ai-capabilities/voice-assistant/ (voice-assistant
// recipe): threshold 0.6, min_speech_duration_ms 300, min_silence_duration_ms
// 700, max_speech_duration_s 15.0, speech_pad_ms 200, sample rate 16 kHz,
// audio_format 'f32le', strategy 'greedy', n_threads 4.
//
// Model constants (WHISPER_TINY, VAD_SILERO_5_1_2, PARAKEET_CTC_0_6B_Q8_0) are
// registry constants exported from '@qvac/sdk'. Pinned SHA-256 checksums are
// mirrored to backend/src/data/qvac-models.json so the integrity banner in the
// renderer can display the same digest as loadModel would verify.
//
// Live audio capture on Bare depends on the `bare-audio` addon. When it is not
// linked into the runtime we fall through to a WAV file source keyed by
// CURVA_COMMENTATOR_WAV_FALLBACK (relative paths resolve against storageDir).
// The consumer loop is identical in both cases: session.write(Uint8Array) ->
// for-await session events -> chat.sendSystem({type:'system:caption', ...}).
// -----------------------------------------------------------------------------

const DEFAULT_STT_LANG = 'en'
const STT_FRAME_SAMPLES = 480   // 30 ms at 16 kHz => 480 f32 samples
const STT_FRAME_BYTES = STT_FRAME_SAMPLES * 4
const STT_FRAME_INTERVAL_MS = 30
// SDK's whisperConfigSchema requires these exact vad_params keys.
// See pear-app/node_modules/@qvac/sdk/dist/schemas/transcription-config.js.
const WHISPER_VAD_PARAMS = Object.freeze({
  threshold: 0.6,
  min_speech_duration_ms: 300,
  min_silence_duration_ms: 700,
  max_speech_duration_s: 15.0,
  speech_pad_ms: 200
})
const WHISPER_STT_CONFIG = Object.freeze({
  strategy: 'greedy',
  n_threads: 4,
  audio_format: 'f32le',
  vad_params: WHISPER_VAD_PARAMS
})

function sttFlagEnabled () {
  try {
    const raw = (typeof process !== 'undefined' && process.env && process.env.CURVA_QVAC_STT_ENABLED) || ''
    const s = String(raw).toLowerCase()
    return s === '1' || s === 'true' || s === 'yes' || s === 'on'
  } catch { return false }
}

/**
 * WAV file async iterator: reads a 16 kHz mono f32le WAV, yields 30 ms frames
 * (480 samples, 1920 bytes). Paced with a setTimeout so the SDK's VAD sees
 * frames arrive at real-time cadence and can emit `vad` / `endOfTurn` events
 * naturally instead of firing them all at once for a buffered file.
 *
 * The 44-byte skip assumes a canonical PCM WAV header. If the caller writes a
 * non-canonical WAV the first frame may be misaligned but VAD will still
 * self-recover; we DO NOT try to parse chunk lists because the demo asset is
 * always canonical.
 *
 * @param {string} wavPath absolute path to a 16kHz mono f32le WAV file
 * @param {{ frameBytes?: number, intervalMs?: number, fsImpl?: any, sleep?: (ms:number)=>Promise<void> }} [opts]
 * @returns {AsyncGenerator<Uint8Array>}
 */
async function * wavFileFrameSource (wavPath, opts = {}) {
  const {
    frameBytes = STT_FRAME_BYTES,
    intervalMs = STT_FRAME_INTERVAL_MS,
    fsImpl = fs,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = opts
  if (typeof wavPath !== 'string' || wavPath.length === 0) {
    throw new TypeError('wavPath required')
  }
  if (!fsImpl || typeof fsImpl.readFileSync !== 'function') {
    throw new Error('fs.readFileSync unavailable in this runtime')
  }
  const buf = fsImpl.readFileSync(wavPath)
  const dataOffset = 44
  if (buf.byteLength <= dataOffset) {
    throw new RangeError('WAV file too short to contain a data chunk')
  }
  const total = buf.byteLength - dataOffset
  const frameCount = Math.floor(total / frameBytes)
  const base = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  for (let i = 0; i < frameCount; i++) {
    const start = dataOffset + i * frameBytes
    // Copy so the SDK's write() cannot inadvertently mutate the caller buffer.
    const frame = base.slice(start, start + frameBytes)
    yield frame
    if (intervalMs > 0) await sleep(intervalMs)
  }
}

/**
 * Split a raw f32le byte buffer into an async iterator of fixed-size frames.
 * Used by tests to exercise the WAV loop without touching the filesystem.
 * Frames shorter than frameBytes at the tail are dropped (VAD would treat a
 * short trailing frame as a fault).
 */
async function * bufferFrameSource (bytes, opts = {}) {
  const { frameBytes = STT_FRAME_BYTES, intervalMs = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const frameCount = Math.floor(view.byteLength / frameBytes)
  for (let i = 0; i < frameCount; i++) {
    const start = i * frameBytes
    yield view.slice(start, start + frameBytes)
    if (intervalMs > 0) await sleep(intervalMs)
  }
}

/**
 * Resolve an audio source based on env + injected overrides. Precedence:
 *   1. opts.audioSource   (test seam; already an async iterable)
 *   2. bare-audio live capture (only if the addon is available AND opts.preferLive)
 *   3. WAV fallback path in CURVA_COMMENTATOR_WAV_FALLBACK
 * Returns null when no source can be produced; caller must emit a caption:error.
 */
function resolveAudioSource ({ audioSource, storageDir, preferLive = false, wavPathOverride = null }) {
  if (audioSource && typeof audioSource[Symbol.asyncIterator] === 'function') {
    return audioSource
  }
  if (preferLive) {
    // bare-audio is not part of the pear-app lockfile as of Wave 14. When it
    // lands, wire the mic capture here and return an async iterator of f32le
    // frames. Until then we skip to the WAV fallback so the demo still works.
    try {
      // eslint-disable-next-line no-unused-vars
      const bareAudio = require('bare-audio')
      // Placeholder: bareAudio.captureF32le({sampleRate:16000}) would go here.
      // Not implemented in Wave 14; fall through.
    } catch { /* addon not present */ }
  }
  const envPath = wavPathOverride
    || (typeof process !== 'undefined' && process.env && process.env.CURVA_COMMENTATOR_WAV_FALLBACK)
    || ''
  if (typeof envPath === 'string' && envPath.length > 0) {
    const abs = path.isAbsolute(envPath) ? envPath : path.join(storageDir || '', envPath)
    return wavFileFrameSource(abs)
  }
  return null
}

/**
 * Build a `system:caption` message for chat.sendSystem. Kept as a pure fn so
 * tests can assert exact shape without booting a room. Caller supplies text +
 * lang + matchTimeMs; wall_clock_ms is stamped here for consistency with the
 * commentary path.
 */
function buildCaptionMessage ({ text, lang, matchTimeMs, source = 'stt', now = () => Date.now() }) {
  if (typeof text !== 'string') throw new TypeError('text required')
  const clean = sanitizeCommentary(text, 96)  // 96-word cap matches ultras path
  return {
    type: 'system:caption',
    text: clean,
    lang: typeof lang === 'string' && lang.length > 0 ? lang.slice(0, 8) : DEFAULT_STT_LANG,
    matchTimeMs: Math.max(0, Number(matchTimeMs) || 0),
    wall_clock_ms: Math.max(0, Number(now()) || 0),
    source: typeof source === 'string' ? source.slice(0, 16) : 'stt'
  }
}

/**
 * @param {{
 *   storageDir: string,
 *   isHost: boolean,
 *   chat: { sendSystem: (msg: any) => Promise<any> },
 *   getMatchTimeMs: () => number,
 *   getMatchTitle?: () => string,
 *   getRecentChat?: () => Array<any>,
 *   sdkFactory?: () => Promise<{ loadModel?: Function, completion: Function, unloadModel?: Function } | null>,
 *   modelSrc?: string,
 *   modelSizeMb?: number,
 *   tickMs?: number,
 *   rateLimitMs?: number,
 *   seekJumpMs?: number,
 *   maxWords?: number,
 *   emit?: (event: string, payload: any) => void,
 *   log?: (level: string, msg: string, extra?: any) => void,
 *   now?: () => number
 * }} opts
 */
function createCommentator (opts = {}) {
  const {
    storageDir,
    isHost = false,
    chat = null,
    getMatchTimeMs = () => 0,
    getMatchTitle = () => 'unknown match',
    getRecentChat = () => [],
    sdkFactory = null,
    modelSrc = DEFAULT_MODEL_SRC,
    modelSizeMb = DEFAULT_MODEL_SIZE_MB,
    // Semifinal QVAC depth: room-scoped kvCache key. Reusing the cache across
    // 60 s ticks in the same room turns the second and later completions into
    // sub-100 ms time-to-first-token calls (verified per docs
    // https://docs.qvac.tether.io/ai-capabilities/text-generation/ kvCache
    // section, fetched 2026-07-10).
    roomSlug = 'default',
    // Wave 13B: extra modelConfig to hand into loadSdkLlm. When roomBot is
    // enabled alongside the commentator we pass { tools: true } so the shared
    // Qwen3 handle can serve both features. When undefined, backward-compat:
    // the commentator loads without any modelConfig, matching pre-13B behavior.
    modelConfig = null,
    tickMs = DEFAULT_TICK_MS,
    rateLimitMs = DEFAULT_RATE_LIMIT_MS,
    seekJumpMs = DEFAULT_SEEK_JUMP_MS,
    maxWords = DEFAULT_MAX_WORDS,
    emit = () => {},
    log = () => {},
    now = () => Date.now()
  } = opts

  if (!storageDir || typeof storageDir !== 'string') {
    throw new TypeError('storageDir is required')
  }
  if (!chat || typeof chat.sendSystem !== 'function') {
    throw new TypeError('chat with sendSystem is required')
  }

  const state = {
    enabled: false,
    modelLoaded: false,
    modelId: null,
    tone: DEFAULT_TONE,
    lastEmitAt: 0,
    streaming: false,
    tickTimer: null,
    destroyed: false,
    lastError: null
  }

  // The SDK LLM handle. `completion({modelId, history, stream})` returns
  // `{ tokenStream: AsyncIterable<string>, ... }` per docs. `unloadModel` is
  // optional; we call it on close() only if the SDK exposes it.
  let sdkHandle = null // { modelId, completion, unloadModel }
  let modelPromise = null

  function status () {
    return {
      enabled: state.enabled,
      modelLoaded: state.modelLoaded,
      streaming: state.streaming,
      tone: state.tone,
      isHost: !!isHost,
      modelSizeMb,
      modelSrc,
      lastError: state.lastError
    }
  }

  function setTone (tone) {
    if (typeof tone !== 'string' || !TONE_PROMPTS[tone]) {
      throw new RangeError('tone must be one of: ' + Object.keys(TONE_PROMPTS).join(', '))
    }
    state.tone = tone
    emit('commentary:status', status())
  }

  async function loadModel () {
    if (!isHost) {
      const err = new Error('only host can load commentator model')
      err.code = 'NOT_HOST'
      throw err
    }
    if (state.modelLoaded && sdkHandle) return sdkHandle
    if (modelPromise) return modelPromise
    modelPromise = (async () => {
      emit('commentary:loading', { modelSrc, modelSizeMb })
      let loaded = null
      try {
        if (typeof sdkFactory === 'function') {
          loaded = await sdkFactory()
          if (loaded && typeof loaded.completion === 'function') {
            // Test seam: sdkFactory returns a ready handle (may include modelId).
            sdkHandle = {
              modelId: loaded.modelId || 'test-model',
              completion: loaded.completion,
              unloadModel: typeof loaded.unloadModel === 'function' ? loaded.unloadModel : null
            }
          } else {
            sdkHandle = null
          }
        } else {
          const loadOpts = {
            modelSrc,
            onProgress: (p) => {
              const pct = typeof p?.percentage === 'number'
                ? p.percentage
                : (typeof p?.percent === 'number' ? p.percent : null)
              emit('commentary:progress', {
                modelSrc,
                percentage: pct,
                downloaded: p?.downloaded ?? null,
                total: p?.total ?? null
              })
            }
          }
          // Wave 13B: only include modelConfig when the caller supplied it, so
          // pre-13B tests (which stub loadSdkLlm and inspect argument shape)
          // still see the exact same call surface.
          if (modelConfig && typeof modelConfig === 'object') {
            loadOpts.modelConfig = modelConfig
          }
          sdkHandle = await loadSdkLlm(loadOpts)
        }
        if (!sdkHandle) {
          state.lastError = 'LLM plugin unavailable in @qvac/sdk'
          emit('commentary:error', { code: 'LLM_UNAVAILABLE', message: state.lastError })
          state.modelLoaded = false
          return null
        }
        state.modelLoaded = true
        state.lastError = null
        emit('commentary:ready', { modelSrc, modelId: sdkHandle.modelId })
        return sdkHandle
      } catch (err) {
        state.modelLoaded = false
        state.lastError = err?.message || 'load failed'
        emit('commentary:error', { code: err?.code || 'LOAD_FAILED', message: state.lastError })
        log('warn', 'commentator load failed', { message: state.lastError })
        return null
      } finally {
        modelPromise = null
      }
    })()
    return modelPromise
  }

  async function enable () {
    if (!isHost) {
      const err = new Error('only host may enable commentator')
      err.code = 'NOT_HOST'
      throw err
    }
    state.enabled = true
    emit('commentary:status', status())
    await loadModel()
    startTickLoop()
    return status()
  }

  function disable () {
    state.enabled = false
    stopTickLoop()
    emit('commentary:status', status())
  }

  function startTickLoop () {
    stopTickLoop()
    if (!state.enabled) return
    state.tickTimer = setInterval(() => {
      if (state.destroyed || !state.enabled) return
      runTrigger({ type: 'tick' }).catch((err) => {
        log('warn', 'commentator tick failed', { message: err?.message })
      })
    }, tickMs)
    // Bare's setInterval may return a numeric handle without .unref(); guard.
    try { state.tickTimer.unref && state.tickTimer.unref() } catch { /* noop */ }
  }

  function stopTickLoop () {
    if (state.tickTimer) {
      try { clearInterval(state.tickTimer) } catch { /* noop */ }
      state.tickTimer = null
    }
  }

  // External signals from workers/main.js. Each returns Promise<boolean>
  // indicating whether commentary was emitted (test observability).
  async function onGoalCluster (payload) {
    return runTrigger({ type: 'goal-cluster', payload })
  }
  async function onSeek (payload) {
    // Skip forward seeks > seekJumpMs; brief says "skip commentary".
    const jump = Number(payload?.jumpMs || 0)
    if (Number.isFinite(jump) && jump > seekJumpMs) {
      log('info', 'commentator: seek jump > threshold, skipping', { jumpMs: jump })
      return false
    }
    // Small seeks are ignored (no signal), we simply do not fire.
    return false
  }

  async function runTrigger (trigger) {
    if (!state.enabled || !state.modelLoaded || !sdkHandle) return false
    if (state.streaming) return false
    const nowMs = now()
    if (nowMs - state.lastEmitAt < rateLimitMs) return false

    state.streaming = true
    state.lastEmitAt = nowMs
    let tokensBuf = ''
    let sawThinking = false
    let sawContent = false
    let stopReason = null
    try {
      const matchTimeMs = Math.max(0, Number(getMatchTimeMs() || 0))
      const prompt = buildPrompt({
        matchTitle: getMatchTitle() || 'unknown match',
        matchTimeSeconds: Math.floor(matchTimeMs / 1000),
        chatContext: safeCall(getRecentChat, []),
        playheadType: trigger?.type || 'tick',
        tone: state.tone,
        maxWords
      })
      emit('commentary:trigger', { type: trigger?.type || 'tick', matchTimeMs })

      const history = [{ role: 'user', content: prompt }]
      // Semifinal: reuse a per-room kvCache so multi-turn requests share the
      // Qwen3 KV so we get sub-100 ms time-to-first-token on repeat triggers.
      // SDK contract: kvCache accepts `true` (auto) or a caller-managed string
      // key. Verified in @qvac/sdk/dist/schemas/completion-stream.d.ts.
      const kvCacheKey = 'commentator:room:' + (roomSlug || 'default')
      const result = sdkHandle.completion({
        modelId: sdkHandle.modelId,
        history,
        stream: true,
        kvCache: kvCacheKey
      })

      // Preferred path: `result.events` is the discriminated union stream
      // documented in dist/schemas/completion-event.d.ts. Event types:
      //   contentDelta{seq,text}, thinkingDelta{seq,text}, toolCall,
      //   toolError, completionStats{stats:{tokensPerSecond,...}},
      //   completionDone{stopReason}.
      // Fallback path: `result.tokenStream` (legacy) or `result.text` (string
      // promise) so pre-Wave-15 fake sdks in existing tests keep working.
      const hasEvents = result && result.events && typeof result.events[Symbol.asyncIterator] === 'function'
      const hasTokenStream = result && result.tokenStream && typeof result.tokenStream[Symbol.asyncIterator] === 'function'

      if (hasEvents) {
        for await (const event of result.events) {
          if (state.destroyed) break
          if (!event || typeof event !== 'object') continue
          if (event.type === 'contentDelta') {
            const chunk = typeof event.text === 'string' ? event.text : ''
            if (!sawContent && chunk.length > 0) {
              sawContent = true
              emit('commentator:content-start', { matchTimeMs })
            }
            tokensBuf += chunk
            // Emit BOTH legacy `commentary:tokens` (for existing renderer +
            // tests) and the new streaming-shaped `commentator:token`.
            emit('commentary:tokens', { token: chunk })
            emit('commentator:token', { text: chunk })
            // Code review fix (High): set stopReason='length' when we hit the
            // char cap so the renderer can distinguish truncation from natural
            // EOS. Without this, the done event defaults to 'eos' and a judge
            // sees a mid-sentence cut labeled as complete.
            if (tokensBuf.length > 600) { stopReason = 'length'; break }
          } else if (event.type === 'thinkingDelta') {
            const chunk = typeof event.text === 'string' ? event.text : ''
            if (!sawThinking && chunk.length > 0) {
              sawThinking = true
              emit('commentator:thinking-start', {})
            }
            emit('commentator:thinking', { text: chunk })
          } else if (event.type === 'completionStats') {
            const stats = (event.stats && typeof event.stats === 'object') ? event.stats : {}
            emit('commentator:stats', {
              tokensPerSecond: Number(stats.tokensPerSecond) || null,
              timeToFirstToken: Number(stats.timeToFirstToken) || null,
              generatedTokens: Number(stats.generatedTokens) || null,
              cacheTokens: Number(stats.cacheTokens) || null,
              backendDevice: typeof stats.backendDevice === 'string' ? stats.backendDevice : null
            })
          } else if (event.type === 'completionDone') {
            stopReason = typeof event.stopReason === 'string' ? event.stopReason : 'eos'
            break
          }
        }
      } else if (hasTokenStream) {
        for await (const token of result.tokenStream) {
          if (state.destroyed) break
          const s = typeof token === 'string' ? token : String(token ?? '')
          tokensBuf += s
          emit('commentary:tokens', { token: s })
          emit('commentator:token', { text: s })
          // Hard cap to prevent runaway generation.
          if (tokensBuf.length > 600) { stopReason = 'length'; break }
        }
        // Code review fix (High): legacy path never emits `commentator:stats`,
        // so the tokens-per-second badge stays dark. Emit a deterministic null
        // stats event so the renderer can decide whether to hide or show a
        // "n/a" state instead of a stuck-loading indicator.
        emit('commentator:stats', {
          tokensPerSecond: null,
          timeToFirstToken: null,
          generatedTokens: null,
          cacheTokens: null,
          backendDevice: null
        })
      } else if (result && typeof result === 'object' && typeof result.text?.then === 'function') {
        // Non-streaming fallback (SDK may in future return {text: Promise<string>}).
        tokensBuf = await result.text
      } else if (typeof result === 'string') {
        tokensBuf = result
      }

      // Always emit a `commentator:done` so renderers can freeze the growing
      // message even when the SDK never sent a completionDone event (legacy
      // tokenStream shape).
      emit('commentator:done', {
        stopReason: stopReason || 'eos',
        totalText: tokensBuf
      })

      const clean = sanitizeCommentary(tokensBuf, maxWords)
      if (clean.length === 0) {
        emit('commentary:error', { code: 'EMPTY_OUTPUT', message: 'model returned no usable text' })
        return false
      }

      const msg = {
        type: 'system:commentary',
        text: clean,
        match_time_ms: matchTimeMs,
        wall_clock_ms: Date.now(),
        tone: state.tone,
        trigger: trigger?.type || 'tick'
      }
      await chat.sendSystem(msg)
      emit('commentary:emitted', { text: clean, tone: state.tone, trigger: msg.trigger })
      return true
    } catch (err) {
      state.lastError = err?.message || 'generation failed'
      emit('commentary:error', { code: err?.code || 'GEN_FAILED', message: state.lastError })
      log('warn', 'commentator run failed', { message: state.lastError })
      return false
    } finally {
      state.streaming = false
    }
  }

  // Wave 14: Whisper STT session state. Kept side-by-side with the LLM state
  // so the same singleton can drive both features on a host machine. Guests
  // never enter this path (isHost gate). Loading Whisper does NOT unload the
  // LLM; the models are additive and share the same @qvac/sdk process.
  const sttState = {
    enabled: false,
    session: null,
    sttModelId: null,
    vadModelId: null,
    lang: DEFAULT_STT_LANG,
    feedError: null,
    consumeError: null,
    feedPromise: null,
    consumePromise: null,
    getMatchTimeMs: null,
    sourceKind: null   // 'live' | 'wav' | 'injected'
  }

  /**
   * Wire the Whisper streaming pipeline. Idempotent: calling twice is a noop.
   *
   * @param {{
   *   audioSource?: AsyncIterable<Uint8Array>,
   *   wavPath?: string,
   *   preferLive?: boolean,
   *   lang?: string,
   *   modelSrc?: string,       // registry constant (defaults to WHISPER_TINY)
   *   vadModelSrc?: string,    // registry constant (defaults to VAD_SILERO_5_1_2)
   *   sdkImpl?: object,        // test seam: shape { loadModel, transcribeStream, unloadModel? }
   *   getMatchTimeMs?: () => number
   * }} sttOpts
   * @returns {Promise<{ enabled: boolean, sourceKind: string, reason?: string }>}
   */
  async function enableSTT (sttOpts = {}) {
    if (!isHost) {
      const err = new Error('only host may enable STT captions')
      err.code = 'NOT_HOST'
      throw err
    }
    if (!sttFlagEnabled()) {
      // Explicit off-by-default: do not silently succeed when the flag is off.
      // Caller (workers/main.js) reads the env before calling us; this is a
      // second belt-and-braces check for tests + programmatic callers.
      emit('caption:disabled', { reason: 'FLAG_OFF' })
      return { enabled: false, sourceKind: null, reason: 'FLAG_OFF' }
    }
    if (sttState.enabled) return { enabled: true, sourceKind: sttState.sourceKind }

    const {
      audioSource,
      wavPath = null,
      preferLive = false,
      lang = DEFAULT_STT_LANG,
      modelSrc = 'WHISPER_TINY',
      vadModelSrc = 'VAD_SILERO_5_1_2',
      sdkImpl = null,
      getMatchTimeMs: sttGetMatchTimeMs = null
    } = sttOpts

    sttState.lang = typeof lang === 'string' && lang.length > 0 ? lang.slice(0, 8) : DEFAULT_STT_LANG
    sttState.getMatchTimeMs = typeof sttGetMatchTimeMs === 'function' ? sttGetMatchTimeMs : getMatchTimeMs

    // 1. Resolve the audio source before touching the SDK. If we cannot even
    //    get bytes, there is no point loading a 74 MB model.
    let source = null
    let sourceKind = null
    if (audioSource && typeof audioSource[Symbol.asyncIterator] === 'function') {
      source = audioSource
      sourceKind = 'injected'
    } else {
      source = resolveAudioSource({ audioSource: null, storageDir, preferLive, wavPathOverride: wavPath })
      if (source) sourceKind = preferLive ? 'live' : 'wav'
    }
    if (!source) {
      const msg = 'no audio source: set CURVA_COMMENTATOR_WAV_FALLBACK or provide audioSource'
      state.lastError = msg
      emit('caption:error', { code: 'AUDIO_UNAVAILABLE', message: msg })
      log('warn', 'commentator STT: no audio source', {})
      return { enabled: false, sourceKind: null, reason: 'AUDIO_UNAVAILABLE' }
    }

    // 2. Resolve the SDK. Prefer injected impl (tests), otherwise import.
    let sdk = sdkImpl
    if (!sdk) {
      try {
        sdk = await import('@qvac/sdk').catch(() => null)
      } catch { sdk = null }
    }
    if (!sdk || typeof sdk.loadModel !== 'function' || typeof sdk.transcribeStream !== 'function') {
      const msg = 'transcribeStream unavailable in @qvac/sdk'
      state.lastError = msg
      emit('caption:error', { code: 'STT_UNAVAILABLE', message: msg })
      return { enabled: false, sourceKind: null, reason: 'STT_UNAVAILABLE' }
    }

    // 3. Load whisper + VAD. The SDK owns integrity verification against the
    //    registry constant's own sha256Checksum. We surface a caption:loading
    //    event so the renderer can drive its progress bar the same way the LLM
    //    path does. If loadModel throws we degrade the room to caption-off
    //    without breaking commentary.
    emit('caption:loading', { modelSrc, vadModelSrc, lang: sttState.lang })
    let sttModelId = null
    try {
      const constants = sdk // registry constants live as string exports on sdk
      const resolvedModelSrc = typeof modelSrc === 'string' && constants[modelSrc] !== undefined
        ? constants[modelSrc]
        : modelSrc
      const resolvedVadSrc = typeof vadModelSrc === 'string' && constants[vadModelSrc] !== undefined
        ? constants[vadModelSrc]
        : vadModelSrc
      // Optional integrity re-check: if the test/injected impl exposes a
      // synchronous byte buffer for the model file, hash it. The prod SDK does
      // this internally, so we only run it when explicitly asked.
      if (typeof sha256Sync === 'function' && sttOpts.__verifyBytes instanceof Uint8Array && typeof sttOpts.__verifyDigest === 'string') {
        const actual = sha256Sync(sttOpts.__verifyBytes)
        const expected = sttOpts.__verifyDigest.replace(/^sha256[-:]/i, '').toLowerCase()
        if (actual.toLowerCase() !== expected) {
          throw Object.assign(new Error('whisper model digest mismatch'), { code: 'DIGEST_MISMATCH' })
        }
      }
      sttModelId = await sdk.loadModel({
        modelSrc: resolvedModelSrc,
        modelType: 'whisper',
        modelConfig: { ...WHISPER_STT_CONFIG, language: sttState.lang, vadModelSrc: resolvedVadSrc },
        onProgress: (p) => emit('caption:progress', {
          modelSrc,
          percentage: p?.percentage ?? p?.percent ?? null,
          downloaded: p?.downloaded ?? null,
          total: p?.total ?? null
        })
      })
      sttState.sttModelId = sttModelId
    } catch (err) {
      state.lastError = err?.message || 'whisper load failed'
      emit('caption:error', { code: err?.code || 'LOAD_FAILED', message: state.lastError })
      log('warn', 'commentator STT load failed', { message: state.lastError })
      return { enabled: false, sourceKind: null, reason: 'LOAD_FAILED' }
    }

    // 4. Open the bidirectional session.
    let session = null
    try {
      session = await sdk.transcribeStream({ modelId: sttModelId })
    } catch (err) {
      state.lastError = err?.message || 'transcribeStream failed to open'
      emit('caption:error', { code: 'SESSION_FAILED', message: state.lastError })
      return { enabled: false, sourceKind: null, reason: 'SESSION_FAILED' }
    }
    sttState.session = session
    sttState.sourceKind = sourceKind
    sttState.enabled = true
    emit('caption:ready', { modelSrc, lang: sttState.lang, sourceKind })
    log('info', 'STT WAV fallback loop started', { sourceKind, lang: sttState.lang })

    // 5. Producer loop.
    sttState.feedPromise = (async () => {
      try {
        for await (const chunk of source) {
          if (state.destroyed || !sttState.enabled) break
          if (!(chunk instanceof Uint8Array)) continue  // guard against bad sources
          try {
            await session.write(chunk)
          } catch (err) {
            sttState.feedError = err?.message || 'session.write failed'
            emit('caption:error', { code: 'FEED_WRITE', message: sttState.feedError })
            break
          }
        }
      } catch (err) {
        sttState.feedError = err?.message || 'audio source error'
        emit('caption:error', { code: 'AUDIO_FEED', message: sttState.feedError })
      } finally {
        if (typeof session.end === 'function') {
          try { await session.end() } catch { /* noop */ }
        }
      }
    })()

    // 6. Consumer loop.
    sttState.consumePromise = (async () => {
      try {
        for await (const event of session) {
          if (state.destroyed) break
          if (!event || typeof event !== 'object') continue
          if (event.type === 'text') {
            const clean = String(event.text || '').trim()
            if (clean.length === 0) continue
            const matchTimeMs = safeCall(sttState.getMatchTimeMs, 0)
            const msg = buildCaptionMessage({
              text: clean,
              lang: sttState.lang,
              matchTimeMs,
              source: 'stt',
              now
            })
            try {
              await chat.sendSystem(msg)
              emit('caption:emitted', { text: msg.text, lang: msg.lang, matchTimeMs: msg.matchTimeMs, source: msg.source })
            } catch (err) {
              emit('caption:error', { code: 'CHAT_SEND', message: err?.message || 'chat.sendSystem failed' })
            }
          } else if (event.type === 'vad') {
            emit('caption:vad', { speaking: !!event.speaking, probability: Number(event.probability) || 0 })
          } else if (event.type === 'endOfTurn') {
            emit('caption:endOfTurn', { source: event.source || null, silenceDurationMs: event.silenceDurationMs ?? null })
          } else if (event.type === 'segment') {
            emit('caption:segment', { segment: event.segment ?? null })
          }
        }
      } catch (err) {
        sttState.consumeError = err?.message || 'stream error'
        emit('caption:error', { code: 'STREAM', message: sttState.consumeError })
      }
    })()

    return { enabled: true, sourceKind, sttModelId }
  }

  async function disableSTT () {
    if (!sttState.enabled) return
    sttState.enabled = false
    const session = sttState.session
    sttState.session = null
    if (session && typeof session.end === 'function') {
      try { await session.end() } catch { /* noop */ }
    }
    // Let the async loops finish naturally; do NOT await here because the SDK's
    // AsyncGenerator does not always resolve on end() in Bare's iteration
    // semantics, and we do not want close() to hang the room.
    emit('caption:disabled', { reason: 'DISABLED' })
  }

  async function close () {
    state.destroyed = true
    state.enabled = false
    stopTickLoop()
    // Tear down STT first so we do not leak an async iterator holding a ref to
    // the SDK's whisper session after the LLM handle unloads.
    if (sttState.enabled || sttState.session) {
      try { await disableSTT() } catch { /* noop */ }
    }
    if (sdkHandle?.unloadModel && sdkHandle.modelId) {
      try { await sdkHandle.unloadModel({ modelId: sdkHandle.modelId }) } catch { /* noop */ }
    }
    sdkHandle = null
    state.modelLoaded = false
  }

  // Wave 13B: expose the loaded LLM handle so a sibling module (roomBot) can
  // reuse the same Qwen3 process instead of loading a second copy. Returns
  // null when the model has not been loaded yet (or was closed). The consumer
  // is read-only: it MUST NOT call unloadModel(). Concurrency is safe because
  // the underlying llamacpp-completion plugin serializes generation per
  // modelId (verified against @qvac/sdk plugin source).
  function getSharedLlmHandle () {
    if (!state.modelLoaded || !sdkHandle) return null
    return {
      modelId: sdkHandle.modelId,
      completion: sdkHandle.completion
      // Intentionally omit unloadModel; only the commentator owns the model's
      // lifecycle. roomBot must NOT unload a shared handle.
    }
  }

  return {
    enable,
    disable,
    setTone,
    onGoalCluster,
    onSeek,
    runTrigger,
    loadModel,
    enableSTT,
    disableSTT,
    status,
    getSharedLlmHandle,
    close,
    _internal: { state, sttState, buildPrompt, sanitizeCommentary, buildCaptionMessage }
  }
}

function safeCall (fn, fallback) {
  try { return fn() } catch { return fallback }
}

// ------------------------------------------------------------------
// Shape validator + host-writer gate for `system:commentary` messages.
// Mirrors the isValidSystem* pattern in bare/chat.js so we can wire the same
// gate model without duplicating regex constants across modules.
// ------------------------------------------------------------------

function isValidSystemCommentary (v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:commentary') return false
  if (typeof v.by_peer !== 'string' || v.by_peer.length === 0) return false
  if (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0) return false
  if (typeof v.match_time_ms !== 'number' || v.match_time_ms < 0) return false
  if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > 280) return false
  if (v.tone !== undefined && (typeof v.tone !== 'string' || v.tone.length > 32)) return false
  if (v.trigger !== undefined && (typeof v.trigger !== 'string' || v.trigger.length > 32)) return false
  return true
}

/**
 * Shape validator for `system:caption` messages. Mirrors the discipline of
 * isValidSystemCommentary so downstream apply() paths can wire the same
 * host-writer gate (checkCommentaryAuthorship) without a second helper.
 */
function isValidSystemCaption (v) {
  if (!v || typeof v !== 'object') return false
  if (v.type !== 'system:caption') return false
  if (typeof v.text !== 'string' || v.text.length === 0 || v.text.length > 280) return false
  if (typeof v.lang !== 'string' || v.lang.length === 0 || v.lang.length > 8) return false
  if (typeof v.matchTimeMs !== 'number' || v.matchTimeMs < 0) return false
  if (v.wall_clock_ms !== undefined && (typeof v.wall_clock_ms !== 'number' || v.wall_clock_ms < 0)) return false
  if (v.source !== undefined && (typeof v.source !== 'string' || v.source.length > 16)) return false
  return true
}

// Host-only gate. Peers who receive a `system:commentary` from a non-host
// writer must drop it at apply(). Mirrors checkHostSystemAuthorship in
// bare/chat.js: pre-init grace (no host writer known yet) permits everything,
// once known only hostWriterHex may author. Guest peers therefore cannot
// forge commentary even if a compromised guest constructs the message.
function checkCommentaryAuthorship (writerHex, hostWriterHex) {
  if (!hostWriterHex) return true
  return writerHex === hostWriterHex
}

module.exports = {
  createCommentator,
  buildPrompt,
  sanitizeCommentary,
  isValidSystemCommentary,
  isValidSystemCaption,
  checkCommentaryAuthorship,
  buildCaptionMessage,
  wavFileFrameSource,
  bufferFrameSource,
  resolveAudioSource,
  sttFlagEnabled,
  PROMPT_TEMPLATE,
  TONE_PROMPTS,
  DEFAULT_MODEL_SRC,
  DEFAULT_MODEL_SIZE_MB,
  DEFAULT_TICK_MS,
  DEFAULT_RATE_LIMIT_MS,
  DEFAULT_MAX_WORDS,
  DEFAULT_TONE,
  DEFAULT_STT_LANG,
  STT_FRAME_SAMPLES,
  STT_FRAME_BYTES,
  STT_FRAME_INTERVAL_MS,
  WHISPER_STT_CONFIG,
  WHISPER_VAD_PARAMS,
  _paths: {
    modelDirFor (storageDir) { return path.join(storageDir || '', 'qvac-llm-models') }
  }
}
