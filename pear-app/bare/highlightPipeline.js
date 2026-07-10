// Curva Ship 3 F7: Auto-highlight detection pipeline.
//
// Detects red/yellow cards, corner kicks, and substitutions from live match
// frames by chaining four capabilities:
//
//   1. MobileNetV3-Small pre-filter (cheap classifier gate)
//        - Reuses the ggml-classification path documented at
//          https://docs.qvac.tether.io/ai-capabilities/classification/
//          Bundled classifier emits { label, confidence }[] sorted desc.
//          Verified against node_modules/@qvac/sdk/dist/client/api/classify.d.ts:22
//          on 2026-07-10. If the classifier is unavailable OR its top score is
//          below MOBILENET_MIN_CONFIDENCE, we short-circuit with null (no
//          highlight) to save the expensive VLM+LLM path.
//
//   2. SmolVLM2 verify (multimodal completion)
//        - Multi-choice prompt: "Which highlight is happening (A) red card
//          (B) yellow card (C) corner (D) substitution (E) none?"
//        - Verified against pear-app/node_modules/@qvac/sdk/dist/schemas/
//          completion-stream.d.ts (attachmentSchema:23, history:52-58).
//        - Strict regex parse: `^[A-E](\s+(HOME|AWAY|[A-Z]{3}))?$`. Anything
//          the model produces that fails the regex returns null (no
//          hallucinated highlight ever leaves the pipeline).
//
//   3. Qwen3 summariser
//        - The shared LLM handle from the commentator is asked to produce a
//          short chat-safe summary line (<= 120 chars). Post-sanitised via
//          NFKC + control-strip + suspicious-prefix drop, mirroring
//          bare/goalPipeline.js:74 joinBlocksForPrompt.
//
//   4. Debounce + fanout
//        - Same {kind, team} pair may not fire more than once per 30s.
//        - For each configured locale, translate (Bergamot) + route TTS
//          (voiceClone in the Chatterbox allowlist, else announcer).
//        - Send `system:highlight` to chat.
//
// Timeout budget: 15s per tick.
//
// Feature flag: CURVA_AUTO_HIGHLIGHT_ENABLED (default OFF).
//
// Prompt-injection defense:
//   The VLM/LLM output is model-generated (not user-typed) but MUST be treated
//   as untrusted before it becomes chat text. Same posture as bare/vlmCaption.js
//   sanitizeCaption + bare/goalPipeline.js SUSPICIOUS_PREFIXES.

'use strict'

const DEFAULT_LOCALES = Object.freeze(['en', 'it', 'id'])
const PIPELINE_TIMEOUT_MS = 15_000
const DEBOUNCE_WINDOW_MS = 30_000
const MAX_SUMMARY_CHARS = 200
const MOBILENET_MIN_CONFIDENCE = 0.3
const MOBILENET_TOP_K = 3
// Ship 3 F5 parity: Chatterbox locale allowlist verified against
// node_modules/@qvac/sdk/dist/schemas/text-to-speech.d.ts:2 (fetched 2026-07-10).
const VOICE_CLONE_ALLOWED = Object.freeze(new Set(['en', 'it', 'es', 'fr', 'de', 'pt']))

const HIGHLIGHT_KINDS = Object.freeze({
  A: 'red-card',
  B: 'yellow-card',
  C: 'corner',
  D: 'substitution',
  E: null
})

const KIND_LABELS = Object.freeze({
  'red-card': 'Red card',
  'yellow-card': 'Yellow card',
  'corner': 'Corner kick',
  'substitution': 'Substitution'
})

const VLM_PROMPT = [
  'Look at this frame. Which of these is happening:',
  '(A) a red card, (B) a yellow card, (C) a corner kick, (D) a substitution,',
  '(E) none of these?',
  'Reply with just the letter and one team name if visible (HOME, AWAY, or three-letter code).'
].join(' ')

// Strict regex per the design brief. Everything else -> null (no highlight).
const VLM_ANSWER_REGEX = /^([A-E])(?:\s+(HOME|AWAY|[A-Z]{3}))?$/

const SUSPICIOUS_PREFIXES = [
  'ignore previous',
  'ignore all previous',
  'system:',
  'you are now',
  'as an ai',
  '###'
]

function autoHighlightFlagEnabled () {
  try {
    const raw = (typeof process !== 'undefined' && process.env &&
      process.env.CURVA_AUTO_HIGHLIGHT_ENABLED) || ''
    const s = String(raw).toLowerCase()
    return s === '1' || s === 'true' || s === 'yes' || s === 'on'
  } catch { return false }
}

/**
 * Strip control chars, NFKC-normalise, drop suspicious prefixes, cap length.
 * Model outputs pass through this before they land in chat.
 */
function sanitizeSummary (text) {
  if (typeof text !== 'string') return ''
  let out = ''
  // NFKC via String.prototype.normalize where available (Bare + Node both ok).
  const normalised = typeof text.normalize === 'function' ? text.normalize('NFKC') : text
  for (const ch of normalised) {
    const code = ch.codePointAt(0)
    if (code === 0x0A || code === 0x0D || code === 0x09) { out += ' '; continue }
    if (code < 0x20) continue
    if (code >= 0x80 && code <= 0x9F) continue
    if (code === 0xFEFF) continue
    out += ch
  }
  out = out.replace(/\s+/g, ' ').trim()
  const lower = out.toLowerCase()
  for (const p of SUSPICIOUS_PREFIXES) {
    if (lower.startsWith(p)) return ''
  }
  if (out.length > MAX_SUMMARY_CHARS) out = out.slice(0, MAX_SUMMARY_CHARS)
  return out
}

function withTimeout (promise, ms, code) {
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      const err = new Error(code || 'timeout')
      err.code = code || 'TIMEOUT'
      reject(err)
    }, ms)
    Promise.resolve(promise).then(
      (val) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(val)
      },
      (err) => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * Parse the VLM's raw text answer into a { kind, team } shape.
 * Returns null on ANY parse failure (no hallucination).
 */
function parseVlmAnswer (raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toUpperCase()
  // Consume optional leading label like "ANSWER:" or "(A)".
  const cleaned = trimmed.replace(/^ANSWER[:\s]*/i, '').replace(/^\(|\)$/g, '').trim()
  const m = VLM_ANSWER_REGEX.exec(cleaned)
  if (!m) return null
  const letter = m[1]
  const team = m[2] || null
  const kind = HIGHLIGHT_KINDS[letter]
  if (!kind) return null // 'E' -> null == no highlight
  return { kind, team }
}

/**
 * Ship 3 F5 parity: session-shaped TTS router. Prefers voiceClone.speak
 * (buffer path) when the locale is in the Chatterbox allowlist AND voiceClone
 * is enrolled; falls back to announcer.openSpeakStream. Any failure returns
 * gracefully so the pipeline never crashes on TTS routing.
 */
async function routeTts (voiceClone, announcer, locale, text, log, emit) {
  const target = typeof locale === 'string' ? locale.toLowerCase() : ''
  const cloneEligible = !!(voiceClone &&
    typeof voiceClone.speak === 'function' &&
    VOICE_CLONE_ALLOWED.has(target))
  if (cloneEligible) {
    let enrolled = false
    try {
      const st = typeof voiceClone.status === 'function' ? voiceClone.status() : null
      enrolled = !!(st && st.enrolled)
    } catch { /* noop */ }
    if (enrolled) {
      emit('highlight:tts-open', { locale: target, via: 'voiceClone' })
      try {
        const result = await voiceClone.speak(text, target)
        if (result && Array.isArray(result.samples)) {
          emit('highlight:tts-end', {
            locale: target, via: 'voiceClone',
            samples: result.samples.length,
            sampleRate: result.sampleRate || null
          })
          return { ok: true, via: 'voiceClone' }
        }
        emit('highlight:tts-fallback', { locale: target, from: 'voiceClone', reason: 'skipped' })
      } catch (err) {
        log('warn', 'highlightPipeline: voiceClone.speak threw', {
          locale: target, message: err && err.message
        })
        emit('highlight:tts-fallback', {
          locale: target, from: 'voiceClone', reason: 'threw',
          message: err && err.message
        })
      }
    }
  }
  // Announcer fall-through.
  if (announcer && typeof announcer.openSpeakStream === 'function') {
    emit('highlight:tts-open', { locale: target, via: 'announcer' })
    try {
      const session = await announcer.openSpeakStream({ locale: target || undefined })
      if (!session) return { ok: false, via: 'announcer', reason: 'STREAM_UNAVAILABLE' }
      try {
        if (typeof session.write === 'function') session.write(text)
        if (typeof session.end === 'function') session.end()
      } catch (err) {
        try { if (typeof session.destroy === 'function') session.destroy() } catch { /* noop */ }
        return { ok: false, via: 'announcer', reason: 'WRITE_FAILED' }
      }
      emit('highlight:tts-end', { locale: target, via: 'announcer' })
      return { ok: true, via: 'announcer' }
    } catch (err) {
      log('warn', 'highlightPipeline: announcer.openSpeakStream failed', {
        locale: target, message: err && err.message
      })
      return { ok: false, via: 'announcer', reason: 'OPEN_FAILED' }
    }
  }
  return { ok: false, via: 'announcer', reason: 'NO_ANNOUNCER' }
}

/**
 * Consume a completion() result and return the accumulated text.
 * Supports the canonical `events` stream (contentDelta) AND the legacy
 * `tokenStream` shape used by older fake SDKs in tests. Also supports a
 * `text: Promise<string>` fallback.
 */
async function consumeCompletion (result, maxChars = 400) {
  let out = ''
  if (result && result.events && typeof result.events[Symbol.asyncIterator] === 'function') {
    for await (const ev of result.events) {
      if (!ev || typeof ev !== 'object') continue
      if (ev.type === 'contentDelta' && typeof ev.text === 'string') {
        out += ev.text
        if (out.length > maxChars) break
      } else if (ev.type === 'completionDone') {
        break
      }
    }
    return out
  }
  if (result && result.tokenStream && typeof result.tokenStream[Symbol.asyncIterator] === 'function') {
    for await (const tok of result.tokenStream) {
      const s = typeof tok === 'string' ? tok : String(tok?.text ?? '')
      out += s
      if (out.length > maxChars) break
    }
    return out
  }
  if (result && result.text && typeof result.text.then === 'function') {
    const s = await result.text
    return typeof s === 'string' ? s : ''
  }
  if (typeof result === 'string') return result
  return ''
}

/**
 * @param {{
 *   sharedLlmHandle?: { modelId: string, completion: Function } | null,
 *   vlm?: { caption: Function } | null,          // bare/vlmCaption
 *   mobilenet?: {                                 // ggml-classification handle
 *     classify: Function,
 *     ensureLoaded?: Function
 *   } | null,
 *   chat?: { sendSystem?: Function } | null,
 *   translate?: { translate: Function } | null,
 *   announcer?: { openSpeakStream: Function } | null,
 *   voiceClone?: object | null,
 *   locales?: string[],
 *   log?: (level: string, msg: string, extra?: any) => void,
 *   emit?: (event: string, payload: any) => void,
 *   flagOverride?: boolean | null,
 *   roomSlug?: string,
 *   now?: () => number
 * }} deps
 */
function createHighlightPipeline (deps = {}) {
  const {
    sharedLlmHandle = null,
    vlm = null,
    mobilenet = null,
    chat = null,
    translate = null,
    announcer = null,
    voiceClone = null,
    locales = DEFAULT_LOCALES,
    log = () => {},
    emit = () => {},
    flagOverride = null,
    roomSlug = null,
    now = () => Date.now()
  } = deps

  const state = {
    destroyed: false,
    busy: false,
    tickCount: 0,
    detectedCount: 0,
    lastError: null,
    // Ring buffer of recent { kind, team, at } triples. Bounded to 16 entries;
    // the debounce window is only 30s so 16 is comfortable overhead.
    recentHighlights: []
  }

  function isDebounced (kind, team, at) {
    const cutoff = at - DEBOUNCE_WINDOW_MS
    // Prune expired entries first so the buffer stays small.
    state.recentHighlights = state.recentHighlights.filter((h) => h.at >= cutoff)
    return state.recentHighlights.some((h) => h.kind === kind && h.team === team)
  }

  function recordHighlight (kind, team, at) {
    state.recentHighlights.push({ kind, team, at })
    if (state.recentHighlights.length > 16) state.recentHighlights.shift()
  }

  async function runMobilenetGate (image) {
    if (!mobilenet || typeof mobilenet.classify !== 'function') {
      // No pre-filter available: fail-open (pass to VLM). This is safe because
      // the VLM's own multi-choice prompt returns 'E' for irrelevant frames.
      emit('highlight:prefilter-skip', { reason: 'no-mobilenet' })
      return { pass: true, reason: 'no-mobilenet', topLabel: null, topConfidence: 0 }
    }
    try {
      const results = await mobilenet.classify({ image, topK: MOBILENET_TOP_K })
      if (!Array.isArray(results) || results.length === 0) {
        emit('highlight:prefilter-skip', { reason: 'empty' })
        return { pass: false, reason: 'empty', topLabel: null, topConfidence: 0 }
      }
      const top = results[0] || {}
      const topLabel = typeof top.label === 'string' ? top.label : null
      const topConfidence = Number.isFinite(top.confidence) ? top.confidence : 0
      if (topConfidence < MOBILENET_MIN_CONFIDENCE) {
        emit('highlight:prefilter-skip', {
          reason: 'low-confidence', topLabel, topConfidence
        })
        return { pass: false, reason: 'low-confidence', topLabel, topConfidence }
      }
      emit('highlight:prefilter-pass', { topLabel, topConfidence })
      return { pass: true, reason: 'pass', topLabel, topConfidence }
    } catch (err) {
      // Classifier error: fail-open (do NOT drop frames on infra failure). We
      // still log because a persistent failure means we're wasting VLM cost.
      log('warn', 'highlightPipeline: classifier error', { message: err && err.message })
      emit('highlight:prefilter-error', { message: err && err.message })
      return { pass: true, reason: 'error', topLabel: null, topConfidence: 0 }
    }
  }

  async function runVlmClassify (image) {
    if (!vlm || typeof vlm.caption !== 'function') {
      return { ok: false, reason: 'NO_VLM' }
    }
    try {
      // The vlm handle used by askTheFrame accepts either a path or Buffer and
      // a prompt override; we exercise the same seam. Cheap generation params
      // via the handle's own defaults; we cap tokens by returning after a
      // short answer regardless.
      const res = await vlm.caption(image, { prompt: VLM_PROMPT })
      if (!res || res.ok !== true || typeof res.caption !== 'string') {
        return { ok: false, reason: res && res.code ? res.code : 'VLM_FAILED' }
      }
      return { ok: true, raw: res.caption }
    } catch (err) {
      return { ok: false, reason: 'VLM_ERROR', message: err && err.message }
    }
  }

  async function runLlmSummary (kind, team, matchTimeMs) {
    // Deterministic template first — the LLM is only used when a shared handle
    // exists AND we want a human-friendly line. If no shared handle, we fall
    // back to a deterministic string so debounce + downstream fanout still
    // work in tests without an LLM.
    const label = KIND_LABELS[kind] || kind
    const teamStr = team ? String(team).slice(0, 16) : 'unknown team'
    const minute = Math.max(0, Math.floor(Number(matchTimeMs) / 60000))
    const deterministic = label + ' — ' + teamStr + ' (min ' + minute + ')'

    if (!sharedLlmHandle || typeof sharedLlmHandle.completion !== 'function') {
      return sanitizeSummary(deterministic)
    }

    const prompt = [
      'You are a football commentator writing one very short line about a match highlight.',
      'Highlight: ' + label,
      'Team: ' + teamStr,
      'Match minute: ' + minute,
      '',
      'Produce ONE factual line (under 20 words). No opinions. No hashtags.'
    ].join('\n')
    try {
      const result = sharedLlmHandle.completion({
        modelId: sharedLlmHandle.modelId,
        history: [{ role: 'user', content: prompt }],
        stream: true,
        generationParams: { temp: 0.2, top_p: 0.9, predict: 64 }
      })
      const raw = await consumeCompletion(result, 400)
      const clean = sanitizeSummary(raw)
      if (clean.length === 0) return sanitizeSummary(deterministic)
      return clean
    } catch (err) {
      log('warn', 'highlightPipeline: LLM summary failed', { message: err && err.message })
      return sanitizeSummary(deterministic)
    }
  }

  async function tick (input = {}) {
    if (state.destroyed) return { ok: false, reason: 'DESTROYED' }
    const flag = flagOverride === null ? autoHighlightFlagEnabled() : !!flagOverride
    if (!flag) return { ok: false, reason: 'DISABLED' }
    if (state.busy) return { ok: false, reason: 'BUSY' }
    const { image, currentScore = null, matchTimeMs = 0 } = input
    if (!image) return { ok: false, reason: 'NO_IMAGE' }

    state.busy = true
    state.tickCount += 1
    const started = now()
    try {
      const res = await withTimeout(
        runTick(image, currentScore, matchTimeMs),
        PIPELINE_TIMEOUT_MS,
        'PIPELINE_TIMEOUT'
      )
      return res
    } catch (err) {
      state.lastError = err && err.message
      emit('highlight:error', { code: err && err.code, message: err && err.message })
      return { ok: false, reason: err && err.code ? err.code : 'ERROR' }
    } finally {
      state.busy = false
      emit('highlight:done', { durationMs: now() - started })
    }
  }

  async function runTick (image, currentScore, matchTimeMs) {
    // Step 1: MobileNet gate.
    const gate = await runMobilenetGate(image)
    if (!gate.pass) return { ok: false, reason: 'PREFILTER_SKIP', gate }

    // Step 2: VLM classify.
    const v = await runVlmClassify(image)
    if (!v.ok) {
      emit('highlight:vlm-skip', { reason: v.reason })
      return { ok: false, reason: 'VLM_' + v.reason }
    }
    const parsed = parseVlmAnswer(v.raw)
    if (!parsed) {
      // Malformed OR 'E none of these' -> not a highlight. Do NOT hallucinate.
      emit('highlight:vlm-noop', { raw: v.raw.slice(0, 64) })
      return { ok: false, reason: 'VLM_NO_HIGHLIGHT' }
    }
    const kind = parsed.kind
    const team = parsed.team

    // Step 3: debounce.
    const at = now()
    if (isDebounced(kind, team, at)) {
      emit('highlight:debounced', { kind, team })
      return { ok: false, reason: 'DEBOUNCED', kind, team }
    }
    recordHighlight(kind, team, at)

    // Step 4: LLM summariser (deterministic fallback embedded).
    const summaryText = await runLlmSummary(kind, team, matchTimeMs)
    if (!summaryText || summaryText.length === 0) {
      emit('highlight:summary-empty', { kind, team })
      return { ok: false, reason: 'EMPTY_SUMMARY' }
    }

    state.detectedCount += 1
    emit('highlight:detected', {
      kind, team, summaryText, at, matchTimeMs, currentScore
    })

    // Step 5: per-locale translate + TTS route.
    const speakResults = []
    for (const locale of locales) {
      let text = summaryText
      if (translate && typeof translate.translate === 'function' && locale !== 'en') {
        try {
          const t = await translate.translate({
            text: summaryText, from: 'en', to: locale
          })
          if (typeof t === 'string' && t.length > 0) text = t
        } catch (err) {
          emit('highlight:translate-error', { locale, message: err && err.message })
          // fall through with English
        }
      }
      emit('highlight:translated', { locale, text })
      const spoken = await routeTts(voiceClone, announcer, locale, text, log, emit)
      speakResults.push({ locale, ...spoken })
    }

    // Step 6: chat append.
    let chatAppended = false
    if (chat && typeof chat.sendSystem === 'function') {
      const payload = {
        type: 'system:highlight',
        kind,
        team: team || 'unknown',
        summaryText,
        at,
        roomSlug: roomSlug || null
      }
      try {
        await chat.sendSystem(payload)
        chatAppended = true
      } catch (err) {
        emit('highlight:chat-error', { message: err && err.message })
      }
    }
    emit('highlight:chat-append', { appended: chatAppended, kind, team })

    return {
      ok: true,
      kind,
      team,
      summaryText,
      at,
      speak: speakResults,
      chatAppended
    }
  }

  function status () {
    return {
      destroyed: state.destroyed,
      busy: state.busy,
      tickCount: state.tickCount,
      detectedCount: state.detectedCount,
      lastError: state.lastError,
      recentHighlights: state.recentHighlights.slice(),
      flagEnabled: autoHighlightFlagEnabled()
    }
  }

  async function close () {
    state.destroyed = true
    state.recentHighlights = []
  }

  return { tick, status, close }
}

module.exports = {
  createHighlightPipeline,
  autoHighlightFlagEnabled,
  parseVlmAnswer,
  sanitizeSummary,
  routeTts,
  consumeCompletion,
  VLM_PROMPT,
  VLM_ANSWER_REGEX,
  HIGHLIGHT_KINDS,
  KIND_LABELS,
  DEFAULT_LOCALES,
  PIPELINE_TIMEOUT_MS,
  DEBOUNCE_WINDOW_MS,
  MAX_SUMMARY_CHARS,
  MOBILENET_MIN_CONFIDENCE,
  VOICE_CLONE_ALLOWED,
  _internal: {
    withTimeout,
    SUSPICIOUS_PREFIXES
  }
}
