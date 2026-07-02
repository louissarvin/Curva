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

const { loadSdkLlm } = require('./translate.js')

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
          sdkHandle = await loadSdkLlm({
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
          })
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
      const result = sdkHandle.completion({
        modelId: sdkHandle.modelId,
        history,
        stream: true
      })

      if (result && result.tokenStream && typeof result.tokenStream[Symbol.asyncIterator] === 'function') {
        for await (const token of result.tokenStream) {
          if (state.destroyed) break
          const s = typeof token === 'string' ? token : String(token ?? '')
          tokensBuf += s
          emit('commentary:tokens', { token: s })
          // Hard cap to prevent runaway generation.
          if (tokensBuf.length > 600) break
        }
      } else if (result && typeof result.text?.then === 'function') {
        // Non-streaming fallback (SDK may in future return {text: Promise<string>}).
        tokensBuf = await result.text
      } else if (typeof result === 'string') {
        tokensBuf = result
      }

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

  async function close () {
    state.destroyed = true
    state.enabled = false
    stopTickLoop()
    if (sdkHandle?.unloadModel && sdkHandle.modelId) {
      try { await sdkHandle.unloadModel({ modelId: sdkHandle.modelId }) } catch { /* noop */ }
    }
    sdkHandle = null
    state.modelLoaded = false
  }

  return {
    enable,
    disable,
    setTone,
    onGoalCluster,
    onSeek,
    runTrigger,
    loadModel,
    status,
    close,
    _internal: { state, buildPrompt, sanitizeCommentary }
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
  checkCommentaryAuthorship,
  PROMPT_TEMPLATE,
  TONE_PROMPTS,
  DEFAULT_MODEL_SRC,
  DEFAULT_MODEL_SIZE_MB,
  DEFAULT_TICK_MS,
  DEFAULT_RATE_LIMIT_MS,
  DEFAULT_MAX_WORDS,
  DEFAULT_TONE,
  _paths: {
    modelDirFor (storageDir) { return path.join(storageDir || '', 'qvac-llm-models') }
  }
}
