// Curva Wave 4 F2: Goal pipeline (OCR -> goalCard -> MCP -> Bergamot -> TTS
// -> Autobase). One user trigger fans out six capabilities.
//
// Docs-verification memo ---------------------------------------------------
//
// Ground truth (installed):
//   bare/ocr.js:373-385 exports { createOcr, extractScore } — ocr.read({image})
//     returns { ok: boolean, blocks: OcrBlock[], durationMs } or
//     { ok: false, code, reason }. extractScore(blocks) returns
//     { home, away, homeLabel?, awayLabel?, source } or null.
//   bare/goalCard.js:204 exports createGoalCard({sharedLlmHandle,...}).parse()
//     returning { ok: true, card: {minute, scorer, team, assist} } or
//     { ok: false, reason }.
//   bare/translate.js:496 translate({text, from, to}) returns Promise<string>.
//   bare/announcer.js:615 openSpeakStream({locale, matchId}) returns
//     { write, end, destroy, chunks } or null. `chunks` is an async iterator
//     of PCM buffers; workers/main.js pipes them to the renderer as
//     `commentator:tts-chunk` events.
//   bare/mcpTools.js:249 createMcpToolsClient — the client exposes
//     invokeTool(name, args). We duck-type on { invokeTool | callTool | updateMatchState }.
//
// Autobase append shape:
//   chat.sendSystem({type, ...}) is the documented host-only path in chat.js
//   (chat.js:571). We defer to it via a caller-supplied `chat` handle so this
//   module remains testable without booting Autobase.
//
// Prompt-injection defense:
//   Raw OCR text is user-controlled (from the video frame). Before feeding
//   into goalCard.parse() we strip control chars, cap length at MAX_OCR_CHARS,
//   and refuse text that contains "system:" style prefixes. goalCard itself
//   has a defence layer (see bare/goalCard.js:100 sanitiseInput) so this is
//   defense-in-depth.
//
// Feature flag: CURVA_GOAL_PIPELINE_ENABLED. Off by default; trigger returns
// { ok: false, reason: 'DISABLED' }.
//
// Idempotency:
//   A single in-flight `trigger()` is allowed at a time. Overlapping calls
//   return { ok: false, reason: 'BUSY' }.
//
// Timeout budget: 30s per trigger.

'use strict'

const MAX_OCR_CHARS = 2000
const DEFAULT_LOCALES = Object.freeze(['en', 'it', 'id'])
const PIPELINE_TIMEOUT_MS = 30_000
const TTS_SESSION_TIMEOUT_MS = 15_000
// F21 OCR audit trail: cap the wait on clips.addClip so a stuck Hyperblob
// write cannot block goal-card announcement. Keep the failure quiet — proof
// is best-effort provenance, not a correctness signal.
const PROOF_SAVE_TIMEOUT_MS = 2_000
const PROOF_BLOB_KIND = 'goal-proof'

function proofFlagEnabled () {
  try {
    const raw = (typeof process !== 'undefined' && process.env &&
      process.env.CURVA_GOAL_PROOF_ENABLED) || ''
    const s = String(raw).toLowerCase()
    return s === '1' || s === 'true' || s === 'yes' || s === 'on'
  } catch { return false }
}

const SUSPICIOUS_PREFIXES = [
  'ignore previous',
  'ignore all previous',
  'system:',
  'you are now',
  'as an ai',
  '###'
]

function pipelineFlagEnabled () {
  try {
    const raw = (typeof process !== 'undefined' && process.env &&
      process.env.CURVA_GOAL_PIPELINE_ENABLED) || ''
    const s = String(raw).toLowerCase()
    return s === '1' || s === 'true' || s === 'yes' || s === 'on'
  } catch { return false }
}

/**
 * Sanitize OCR blocks into a single prompt-safe line for goalCard.
 * @param {Array<{text?: string, confidence?: number}>} blocks
 * @param {number} minConfidence
 * @returns {string | null}
 */
function joinBlocksForPrompt (blocks, minConfidence = 0.5) {
  if (!Array.isArray(blocks)) return null
  const pieces = []
  for (const b of blocks) {
    if (!b || typeof b.text !== 'string') continue
    if (typeof b.confidence === 'number' && b.confidence < minConfidence) continue
    // Strip control chars, drop suspicious prefix probes.
    let t = b.text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()
    if (!t) continue
    const lower = t.toLowerCase()
    if (SUSPICIOUS_PREFIXES.some((p) => lower.startsWith(p))) continue
    pieces.push(t)
  }
  if (pieces.length === 0) return null
  let joined = pieces.join(' ').replace(/\s+/g, ' ').trim()
  if (joined.length > MAX_OCR_CHARS) joined = joined.slice(0, MAX_OCR_CHARS)
  return joined
}

function scoresEqual (a, b) {
  if (!a || !b) return false
  return Number(a.home) === Number(b.home) && Number(a.away) === Number(b.away)
}

function buildAnnouncement (card) {
  const scorer = String(card.scorer).slice(0, 80)
  const team = String(card.team).slice(0, 60)
  const minute = Number(card.minute)
  const assist = typeof card.assist === 'string' && card.assist.length > 0
    ? String(card.assist).slice(0, 80) : null
  const base = 'Goal! ' + scorer + ' scored for ' + team + ' in the ' +
    minute + 'th minute.'
  return assist ? base + ' Assist by ' + assist + '.' : base
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

// Duck-type shim for the MCP client. The production MCP tools server does
// not yet expose an `updateMatchState` tool (see bare/mcpTools.js:80 tools
// array). Rather than mutate mcpTools.js (out of scope) we accept any of:
//   mcp.updateMatchState({...})
//   mcp.invokeTool('updateMatchState', {...})
//   mcp.callTool('updateMatchState', {...})
// If none are present we treat MCP as unavailable (graceful degradation).
async function tryUpdateMatchState (mcp, payload) {
  if (!mcp) return { ok: false, reason: 'NO_MCP' }
  try {
    if (typeof mcp.updateMatchState === 'function') {
      const res = await mcp.updateMatchState(payload)
      return { ok: true, res }
    }
    if (typeof mcp.invokeTool === 'function') {
      const res = await mcp.invokeTool('updateMatchState', payload)
      return { ok: true, res }
    }
    if (typeof mcp.callTool === 'function') {
      const res = await mcp.callTool('updateMatchState', payload)
      return { ok: true, res }
    }
  } catch (err) {
    return { ok: false, reason: 'MCP_ERROR', message: err && err.message }
  }
  return { ok: false, reason: 'NO_MCP_TOOL' }
}

// Ship 3 F1: locale gate for voice-cloned TTS routing. Mirrors the
// ALLOWED_CLONE_LOCALES set in bare/voiceClone.js. We keep the constant here
// (rather than import it) so the pipeline can decide routing without waiting
// for the async voiceClone factory to resolve. Any drift from voiceClone.js
// costs us a `LOCALE_NOT_SUPPORTED` skip event; graceful fall-through to
// announcer follows automatically.
const VOICE_CLONE_ALLOWED = Object.freeze(new Set(['en', 'it', 'es', 'fr', 'de', 'pt']))

// Ship 3 F1: route the announcement through the voice-cloned Chatterbox TTS
// when a `voiceClone` handle is passed AND the locale is in Chatterbox's
// supported set. Never fails the pipeline — a thrown voiceClone.speak falls
// back to announcer. Emits `goalpipe:tts-open` and `goalpipe:tts-end` with a
// `via` field ('voiceClone' | 'announcer') so the renderer can badge the row.
async function routeTts (voiceClone, announcer, locale, text, log, emit) {
  const cloneEligible = !!(voiceClone &&
    typeof voiceClone.speak === 'function' &&
    VOICE_CLONE_ALLOWED.has(String(locale).toLowerCase()))
  if (cloneEligible) {
    emit('goalpipe:tts-open', { locale, via: 'voiceClone' })
    try {
      const result = await voiceClone.speak(text, locale)
      if (result && (Array.isArray(result.samples) || typeof result.sampleRate === 'number')) {
        emit('goalpipe:tts-end', {
          locale,
          via: 'voiceClone',
          samples: Array.isArray(result.samples) ? result.samples.length : 0,
          sampleRate: result.sampleRate || null
        })
        // Keep parity with the announcer path for callers that still watch
        // for the legacy speak-open / speak-end names.
        emit('goalpipe:speak-open', { locale, via: 'voiceClone' })
        emit('goalpipe:speak-end', { locale, via: 'voiceClone' })
        return { ok: true, via: 'voiceClone' }
      }
      // null result means the voiceClone factory skipped (no reference, feature
      // flag off, or empty text). Fall through to announcer.
      log('warn', 'voiceClone skipped; falling back to announcer', { locale })
      emit('goalpipe:tts-fallback', { locale, from: 'voiceClone', reason: 'skipped' })
    } catch (err) {
      log('warn', 'voiceClone.speak threw; falling back to announcer', {
        locale, message: err && err.message
      })
      emit('goalpipe:tts-fallback', {
        locale, from: 'voiceClone', reason: 'threw',
        message: err && err.message
      })
    }
  }
  emit('goalpipe:tts-open', { locale, via: 'announcer' })
  const spoken = await speakOnce(announcer, locale, text, log, emit)
  emit('goalpipe:tts-end', { locale, via: 'announcer', ok: !!spoken.ok })
  return { ...spoken, via: 'announcer' }
}

// Duck-type shim for the announcer. In production `announcer.openSpeakStream`
// returns { write, end, chunks } (see bare/announcer.js:615). We only need to
// write once and end, then optionally drain `chunks` so the PCM lands on the
// commentator bus.
async function speakOnce (announcer, locale, text, log, emit) {
  if (!announcer || typeof announcer.openSpeakStream !== 'function') {
    return { ok: false, reason: 'NO_ANNOUNCER' }
  }
  let session
  try {
    session = await announcer.openSpeakStream({ locale })
  } catch (err) {
    emit('goalpipe:speak-open-error', { locale, message: err && err.message })
    return { ok: false, reason: 'OPEN_FAILED', message: err && err.message }
  }
  if (!session) {
    return { ok: false, reason: 'STREAM_UNAVAILABLE' }
  }
  emit('goalpipe:speak-open', { locale })
  try {
    if (typeof session.write === 'function') session.write(text)
    if (typeof session.end === 'function') session.end()
  } catch (err) {
    try { if (typeof session.destroy === 'function') session.destroy() } catch { /* noop */ }
    emit('goalpipe:speak-write-error', { locale, message: err && err.message })
    return { ok: false, reason: 'WRITE_FAILED' }
  }
  // Drain chunks (optional, best-effort, bounded).
  if (session.chunks && typeof session.chunks[Symbol.asyncIterator] === 'function') {
    let chunkCount = 0
    try {
      await withTimeout((async () => {
        for await (const chunk of session.chunks) {
          chunkCount += 1
          if (chunk && chunk.done) break
          if (chunkCount > 1024) break // hard safety cap
        }
      })(), TTS_SESSION_TIMEOUT_MS, 'TTS_DRAIN_TIMEOUT')
    } catch (err) {
      log('warn', 'tts drain failed', { locale, message: err && err.message })
    }
  }
  emit('goalpipe:speak-end', { locale })
  return { ok: true }
}

/**
 * Six-capability goal pipeline: OCR -> goalCard -> MCP -> Bergamot -> TTS ->
 * Autobase. Centralising the fan-out means the per-locale best-effort policy,
 * the 30 s timeout budget, and the BUSY guard live in exactly one place.
 * See ADR-007 for the failure model and per-locale ordering.
 *
 * @param {{
 *   ocr:        { read: Function },
 *   goalCard:   { parse: Function },
 *   mcp?:       object | null,
 *   translate?: { translate: Function } | null,
 *   announcer?: { openSpeakStream: Function } | null,
 *   chat?:      { sendSystem?: Function, appendSystem?: Function } | null,
 *   roomSlug?:  string,
 *   locales?:   string[],
 *   log?:       (level: string, msg: string, extra?: any) => void,
 *   emit?:      (event: string, payload: any) => void,
 *   flagOverride?: boolean
 * }} deps
 * @returns {{ trigger: Function, close: Function, status: Function }}
 */
// F21 OCR audit trail: save the source frame to Hyperblob as a `goal-proof`
// clip so the goal-card carries a verifiable provenance handle other peers can
// pull. This is best-effort — a failure returns null and the pipeline emits a
// `goalpipe:proof-failed` event but still ships the goal-card without a
// proofBlobKey. Never rethrows.
async function saveGoalProof (clips, imageBytes, matchTimeMs, emit, log) {
  if (!clips || typeof clips.addClip !== 'function') {
    emit('goalpipe:proof-failed', { reason: 'NO_CLIPS_HANDLE' })
    return null
  }
  const bytes = imageBytes
  const size = (bytes && typeof bytes.length === 'number') ? bytes.length : 0
  const mt = Number.isFinite(matchTimeMs) && matchTimeMs >= 0 ? Math.floor(matchTimeMs) : 0
  try {
    const stored = await withTimeout(
      Promise.resolve(clips.addClip({
        buffer: bytes,
        match_time_ms: mt,
        caption: PROOF_BLOB_KIND
      })),
      PROOF_SAVE_TIMEOUT_MS,
      'PROOF_TIMEOUT'
    )
    if (!stored) {
      emit('goalpipe:proof-failed', { reason: 'EMPTY_RESULT' })
      return null
    }
    // clips.addClip returns { clipId, driveKey, path, ts, match_time_ms, by_peer, caption? }.
    // We synthesize a compact blob key that carries enough state for a peer to
    // resolve the clip via curva.clips.getClip: driveKey/path is sufficient.
    // The key format is `<driveKey>:<path>` — both fields already validated by
    // clips.addClip. Cap total length inside 16..256 char validator bounds.
    let blobKey = null
    if (typeof stored.driveKey === 'string' && typeof stored.path === 'string'
        && stored.driveKey.length >= 8 && stored.path.length >= 1) {
      blobKey = stored.driveKey + ':' + stored.path
      if (blobKey.length < 16 || blobKey.length > 256) blobKey = null
    }
    if (!blobKey) {
      emit('goalpipe:proof-failed', { reason: 'INVALID_KEY_SHAPE' })
      return null
    }
    emit('goalpipe:proof-saved', { blobKey, sizeBytes: size })
    return blobKey
  } catch (err) {
    const code = err && err.code ? err.code : 'ERROR'
    log('warn', 'goalPipeline: proof save failed', { code, message: err && err.message })
    emit('goalpipe:proof-failed', { reason: code, message: err && err.message })
    return null
  }
}

function createGoalPipeline (deps = {}) {
  const {
    ocr = null,
    goalCard = null,
    mcp = null,
    translate = null,
    announcer = null,
    // Ship 3 F1: optional voice-cloned Chatterbox handle. When present AND
    // the locale is in VOICE_CLONE_ALLOWED, `routeTts` routes there instead
    // of announcer.openSpeakStream. Any failure falls back to announcer so
    // the pipeline never crashes on TTS routing.
    voiceClone = null,
    // F21 OCR audit trail: optional clips handle (from bare/clips.js) used to
    // publish the source frame as a `goal-proof` Hyperblob before the
    // system:goal-card is appended. Missing handle => proof step is skipped
    // silently. See saveGoalProof for the failure model.
    clips = null,
    chat = null,
    roomSlug = null,
    locales = DEFAULT_LOCALES,
    log = () => {},
    emit = () => {},
    flagOverride = null,
    // F21 feature flag override for tests; production defers to the env flag
    // CURVA_GOAL_PROOF_ENABLED which is OFF by default.
    proofFlagOverride = null,
    // Wave-final QVAC polish (F1): injected `deleteCache` fn. goalPipeline
    // itself does not call completion() directly (goalCard owns that seam),
    // but close() still clears the room-scoped kvCache for the goal-pipeline
    // namespace so a hot room switch does not leak KV state from prior goal
    // events. Verified per @qvac/sdk dist/client/api/delete-cache.d.ts:22.
    deleteCacheImpl = null
  } = deps

  if (!ocr || typeof ocr.read !== 'function') {
    throw new TypeError('createGoalPipeline requires ocr.read')
  }
  if (!goalCard || typeof goalCard.parse !== 'function') {
    throw new TypeError('createGoalPipeline requires goalCard.parse')
  }

  const state = {
    busy: false,
    triggerCount: 0,
    successCount: 0,
    lastScore: null,
    lastError: null,
    destroyed: false
  }

  async function trigger (input = {}) {
    if (state.destroyed) return { ok: false, reason: 'DESTROYED' }
    const flag = flagOverride === null ? pipelineFlagEnabled() : !!flagOverride
    if (!flag) return { ok: false, reason: 'DISABLED' }
    if (state.busy) return { ok: false, reason: 'BUSY' }

    const { image, currentScore = null } = input
    if (!image) return { ok: false, reason: 'NO_IMAGE' }

    state.busy = true
    state.triggerCount += 1
    const started = Date.now()
    try {
      const result = await withTimeout(
        runPipeline(image, currentScore),
        PIPELINE_TIMEOUT_MS,
        'PIPELINE_TIMEOUT'
      )
      if (result.ok) state.successCount += 1
      return result
    } catch (err) {
      state.lastError = err && err.message
      emit('goalpipe:error', { code: err && err.code, message: err && err.message })
      return { ok: false, reason: err && err.code ? err.code : 'ERROR' }
    } finally {
      state.busy = false
      emit('goalpipe:done', { durationMs: Date.now() - started })
    }
  }

  async function runPipeline (image, currentScore) {
    // Step 1: OCR the frame.
    const ocrResult = await ocr.read({ image })
    if (!ocrResult || ocrResult.ok !== true) {
      emit('goalpipe:ocr-failed', { reason: ocrResult && ocrResult.reason })
      return { ok: false, reason: 'OCR_FAILED' }
    }
    const blocks = Array.isArray(ocrResult.blocks) ? ocrResult.blocks : []
    emit('goalpipe:ocr', { blockCount: blocks.length })

    // Step 2: score change guard. If the OCR-derived score is identical to
    // the `currentScore` the caller passed, there is nothing to announce.
    // This is our defence against noisy OCR that fires when nothing happened.
    let extractScore = null
    try {
      const ocrMod = require('./ocr.js')
      extractScore = ocrMod && ocrMod.extractScore
    } catch { /* optional dep */ }
    const nextScore = typeof extractScore === 'function' ? extractScore(blocks) : null
    if (nextScore && currentScore && scoresEqual(nextScore, currentScore)) {
      emit('goalpipe:no-change', { score: nextScore })
      return { ok: false, reason: 'NO_CHANGE' }
    }
    state.lastScore = nextScore

    // Step 3: prompt-safe sanitisation of OCR text.
    const promptText = joinBlocksForPrompt(blocks)
    if (!promptText) {
      emit('goalpipe:parse-skip', { reason: 'NO_TEXT' })
      return { ok: false, reason: 'NO_TEXT' }
    }

    // Step 4: goalCard parse.
    let parsed
    try {
      parsed = await goalCard.parse(promptText)
    } catch (err) {
      emit('goalpipe:parse-error', { message: err && err.message })
      return { ok: false, reason: 'PARSE_ERROR' }
    }
    if (!parsed || parsed.ok !== true || !parsed.card) {
      emit('goalpipe:parse-failed', { reason: parsed && parsed.reason })
      return { ok: false, reason: 'PARSE_FAILED' }
    }
    const card = parsed.card
    emit('goalpipe:parsed', {
      minute: card.minute,
      scorer: card.scorer,
      team: card.team,
      assist: card.assist
    })

    // Step 5: MCP updateMatchState (best-effort, non-fatal).
    const mcpResult = await tryUpdateMatchState(mcp, {
      minute: card.minute,
      score: nextScore || null,
      event: 'goal'
    })
    emit('goalpipe:mcp', { ok: mcpResult.ok, reason: mcpResult.reason })

    // Step 6: translate + speak per locale (best-effort per locale).
    const baseAnnouncement = buildAnnouncement(card)
    const speakResults = []
    for (const locale of locales) {
      let text = baseAnnouncement
      if (translate && typeof translate.translate === 'function' && locale !== 'en') {
        try {
          const t = await translate.translate({
            text: baseAnnouncement, from: 'en', to: locale
          })
          if (typeof t === 'string' && t.length > 0) text = t
        } catch (err) {
          emit('goalpipe:translate-error', { locale, message: err && err.message })
          // fall through with English text — better to say something than nothing.
        }
      }
      emit('goalpipe:translated', { locale, text })
      const spoken = await routeTts(voiceClone, announcer, locale, text, log, emit)
      speakResults.push({ locale, ...spoken })
    }

    // Step 6.5: F21 OCR audit trail. When the proof feature flag is on AND a
    // clips handle is available, publish the source frame to Hyperblob so the
    // goal-card carries a verifiable provenance handle. Best-effort — a
    // failure returns null and the pipeline STILL ships the goal-card without
    // proofBlobKey. Never blocks the pipeline for more than PROOF_SAVE_TIMEOUT_MS.
    const proofFlag = proofFlagOverride === null
      ? proofFlagEnabled()
      : !!proofFlagOverride
    let proofBlobKey = null
    if (proofFlag && clips) {
      const matchTimeForProof = (nextScore && Number.isFinite(nextScore.matchTimeMs))
        ? nextScore.matchTimeMs
        : 0
      proofBlobKey = await saveGoalProof(clips, image, matchTimeForProof, emit, log)
    }

    // Step 7: append `system:goal-card` to Autobase chat.
    let chatAppended = false
    if (chat) {
      const payload = {
        type: 'system:goal-card',
        minute: card.minute,
        scorer: card.scorer,
        team: card.team,
        assist: card.assist,
        roomSlug: roomSlug || null
      }
      // F21: attach proofBlobKey when saveGoalProof succeeded. Missing key is
      // valid per the chat.js validator (backward compat).
      if (typeof proofBlobKey === 'string' && proofBlobKey.length >= 16
          && proofBlobKey.length <= 256) {
        payload.proofBlobKey = proofBlobKey
      }
      try {
        if (typeof chat.sendSystem === 'function') {
          await chat.sendSystem(payload)
          chatAppended = true
        } else if (typeof chat.appendSystem === 'function') {
          await chat.appendSystem(payload)
          chatAppended = true
        }
      } catch (err) {
        emit('goalpipe:chat-error', { message: err && err.message })
      }
    }
    emit('goalpipe:chat-append', { appended: chatAppended })

    return {
      ok: true,
      card,
      score: nextScore,
      mcp: mcpResult,
      speak: speakResults,
      chatAppended,
      proofBlobKey
    }
  }

  async function close () {
    state.destroyed = true
    // Wave-final QVAC polish (F1): best-effort per-room kvCache release. Only
    // fires when an injected deleteCacheImpl is present. We do NOT dynamic-
    // import '@qvac/sdk' from close() to avoid spinning up the SDK worker in
    // test environments. workers/main.js wires the real deleteCache via
    // `deleteCacheImpl` at construction.
    const key = 'goalpipe:room:' + String(roomSlug || 'default').slice(0, 64)
    const deleteFn = typeof deleteCacheImpl === 'function' ? deleteCacheImpl : null
    if (deleteFn) {
      try {
        await deleteFn({ kvCacheKey: key })
        emit('goalpipe:kvcache-cleared', { key })
      } catch (err) {
        log('warn', 'goalPipeline: deleteCache failed', { message: err && err.message })
      }
    }
  }

  function status () {
    return {
      busy: state.busy,
      triggerCount: state.triggerCount,
      successCount: state.successCount,
      lastScore: state.lastScore,
      lastError: state.lastError,
      destroyed: state.destroyed
    }
  }

  return { trigger, close, status }
}

module.exports = {
  createGoalPipeline,
  pipelineFlagEnabled,
  DEFAULT_LOCALES,
  MAX_OCR_CHARS,
  VOICE_CLONE_ALLOWED,
  proofFlagEnabled,
  PROOF_SAVE_TIMEOUT_MS,
  PROOF_BLOB_KIND,
  _internal: {
    joinBlocksForPrompt,
    scoresEqual,
    buildAnnouncement,
    tryUpdateMatchState,
    speakOnce,
    routeTts,
    withTimeout,
    saveGoalProof
  }
}
