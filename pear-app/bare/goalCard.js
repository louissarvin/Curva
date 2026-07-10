// Curva Wave 3 F3: LLM structured-output goal card (json_schema mode).
//
// Docs-verification memo ---------------------------------------------------
//
// Ground truth (installed):
//   pear-app/node_modules/@qvac/sdk/dist/schemas/completion-stream.d.ts:38-50
//     responseFormatSchema is a discriminated union of:
//       { type: 'text' }
//       { type: 'json_object' }
//       { type: 'json_schema',
//         json_schema: {
//           name: string, description?: string,
//           schema: Record<string, unknown>,
//           strict?: boolean
//         } }
//     (`z.core.$strict` on the outer object => unknown fields rejected.)
//
//   Same file, line 116 confirms `responseFormat` is optional on
//   `completionClientParamsSchema` — we pass it only when parsing.
//
// `strict: true` in the SDK is passed through to the OpenAI-compatible
// runtime layer. Per the completion-stream.d.ts comment: `strict:true` is
// OpenAI-compat only and does NOT trigger implicit `additionalProperties:false`.
// We therefore encode strictness by hand in the schema (see GOAL_CARD_SCHEMA
// below): explicit `type: 'object'`, `additionalProperties: false`, `required`
// listing every property.
//
// Docs: https://docs.qvac.tether.io/ai-capabilities/text-generation/ (fetched
// 2026-07-10).
//
// Design:
//   - `createGoalCard({sdk, sharedLlmHandle, log, emit})` returns
//     `{ parse(scoreboardText), close(), status() }`.
//   - `parse(text)` calls
//     `completion({modelId, history, responseFormat: {type: 'json_schema',
//                  json_schema: {name: 'goalCard', schema, strict: true}},
//                  stream: false})`.
//   - Returns `{ ok: true, card: {minute, scorer, team, assist} }` OR
//     `{ ok: false, reason }` on refusal / parse failure. Never throws.
//   - Input validation: caller-supplied text <= 2000 chars, non-empty.
//   - Emits `goalcard:parsed {minute, scorer, team}` for the commentator.

'use strict'

const GOAL_CARD_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['minute', 'scorer', 'team', 'assist'],
  properties: {
    minute: {
      type: 'integer',
      minimum: 0,
      maximum: 200,
      description: 'The match minute at which the goal was scored (0-200).'
    },
    scorer: {
      type: 'string',
      minLength: 1,
      maxLength: 80,
      description: 'Name of the player who scored.'
    },
    team: {
      type: 'string',
      minLength: 1,
      maxLength: 60,
      description: 'Full team name (e.g. "Italy", "Argentina").'
    },
    assist: {
      // Nullable via a union: allow the model to explicitly return `null`
      // when the goal had no assist. This is safer than making `assist`
      // optional because the strict object model requires ALL keys.
      type: ['string', 'null'],
      maxLength: 80,
      description: 'Name of the assisting player, or null if unassisted.'
    }
  }
})

const MAX_INPUT_CHARS = 2000
const MAX_OUTPUT_CHARS = 4096

const SYSTEM_PROMPT = [
  'You are a football scoreboard parser.',
  'Given a raw scoreboard OCR or transcript line describing a goal event,',
  'extract the four fields into the GoalCard schema.',
  'The `minute` is an integer between 0 and 200.',
  'If no assist is present, return `assist: null`.',
  'Reply ONLY with the JSON object; no code fences, no prose.'
].join(' ')

function goalCardFlagEnabled () {
  try {
    const raw = (typeof process !== 'undefined' && process.env &&
      process.env.CURVA_GOAL_CARD_ENABLED) || ''
    const s = String(raw).toLowerCase()
    return s === '1' || s === 'true' || s === 'yes' || s === 'on'
  } catch { return false }
}

function sanitiseInput (text) {
  if (typeof text !== 'string') return null
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code === 0x0A || code === 0x0D || code === 0x09) { out += ' '; continue }
    if (code < 0x20) continue
    if (code >= 0x80 && code <= 0x9F) continue
    if (code === 0xFEFF) continue
    out += ch
  }
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length === 0) return null
  if (out.length > MAX_INPUT_CHARS) out = out.slice(0, MAX_INPUT_CHARS)
  return out
}

/**
 * Extract a JSON object from a raw string. LLMs occasionally leak a `<think>`
 * prelude or a code fence even when the schema mode is on; we peel that off
 * and take the first balanced `{...}` block. Returns null on failure.
 */
function extractJsonObject (raw) {
  if (typeof raw !== 'string') return null
  if (raw.length > MAX_OUTPUT_CHARS) raw = raw.slice(0, MAX_OUTPUT_CHARS)
  // Fast path: entire string is valid JSON.
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch { /* fall through */ }
  // Slow path: find first '{' and last matching '}'. Balanced brace tracking
  // avoids grabbing an embedded string that contains a `}`.
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const candidate = raw.slice(start, i + 1)
        try {
          const parsed = JSON.parse(candidate)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
        } catch { return null }
      }
    }
  }
  return null
}

/**
 * Validate a candidate object against the GoalCard schema. This is a
 * minimal validator — the SDK enforces JSON-schema constraints itself when
 * `strict: true`, but we defence-in-depth to prevent an off-spec model from
 * shipping garbage upstream.
 */
function validateCard (obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not_object' }
  const { minute, scorer, team, assist } = obj
  // Extra key rejection (mirrors additionalProperties:false).
  const keys = Object.keys(obj).sort().join(',')
  if (keys !== 'assist,minute,scorer,team') {
    return { ok: false, reason: 'extra_or_missing_keys' }
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 200) {
    return { ok: false, reason: 'bad_minute' }
  }
  if (typeof scorer !== 'string' || scorer.length === 0 || scorer.length > 80) {
    return { ok: false, reason: 'bad_scorer' }
  }
  if (typeof team !== 'string' || team.length === 0 || team.length > 60) {
    return { ok: false, reason: 'bad_team' }
  }
  if (assist !== null && (typeof assist !== 'string' || assist.length > 80)) {
    return { ok: false, reason: 'bad_assist' }
  }
  return {
    ok: true,
    card: {
      minute,
      scorer: scorer.trim(),
      team: team.trim(),
      assist: typeof assist === 'string' ? assist.trim() : null
    }
  }
}

/**
 * @param {{
 *   sdk?: object | null,
 *   sdkImpl?: object | null,           // test seam (accepts a completion fn directly)
 *   sharedLlmHandle?: { modelId: string, completion: Function } | null,
 *   log?: (level: string, msg: string, extra?: any) => void,
 *   emit?: (event: string, payload: any) => void
 * }} opts
 */
function createGoalCard (opts = {}) {
  const {
    sharedLlmHandle = null,
    sdkImpl = null,
    log = () => {},
    emit = () => {}
  } = opts

  const state = {
    destroyed: false,
    lastError: null,
    parseCount: 0,
    successCount: 0,
    failureCount: 0
  }

  function resolveHandle () {
    if (sharedLlmHandle && typeof sharedLlmHandle.completion === 'function' &&
        typeof sharedLlmHandle.modelId === 'string') {
      return sharedLlmHandle
    }
    if (sdkImpl && typeof sdkImpl.completion === 'function' &&
        typeof sdkImpl.modelId === 'string') {
      return sdkImpl
    }
    return null
  }

  /**
   * Parse `scoreboardText` into a GoalCard. Non-fatal on every failure path.
   * @param {string} scoreboardText
   * @returns {Promise<{ok: true, card: object} | {ok: false, reason: string}>}
   */
  async function parse (scoreboardText) {
    if (state.destroyed) return { ok: false, reason: 'destroyed' }

    const clean = sanitiseInput(scoreboardText)
    if (!clean) {
      emit('goalcard:skip', { reason: 'INVALID_INPUT' })
      return { ok: false, reason: 'invalid_input' }
    }

    const handle = resolveHandle()
    if (!handle) {
      emit('goalcard:skip', { reason: 'NO_LLM_HANDLE' })
      return { ok: false, reason: 'no_llm_handle' }
    }

    state.parseCount += 1
    const history = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: clean }
    ]

    let result
    try {
      result = handle.completion({
        modelId: handle.modelId,
        history,
        stream: false,
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'goalCard',
            description: 'Structured extraction of a football goal event.',
            schema: GOAL_CARD_SCHEMA,
            strict: true
          }
        }
      })
    } catch (err) {
      state.failureCount += 1
      state.lastError = err && err.message
      emit('goalcard:error', {
        code: 'COMPLETION_THROW', message: err && err.message
      })
      return { ok: false, reason: 'completion_threw' }
    }

    let rawText = ''
    try {
      // The SDK returns either `{ text: Promise<string> }` (non-stream mode)
      // or `{ events: AsyncIterable }`. We try both to remain compatible with
      // the events-based fake used elsewhere in the test suite.
      if (result && typeof result === 'object' && result.text &&
          typeof result.text.then === 'function') {
        rawText = String(await result.text || '')
      } else if (result && typeof result === 'object' &&
                 result.events && typeof result.events[Symbol.asyncIterator] === 'function') {
        for await (const event of result.events) {
          if (!event || typeof event !== 'object') continue
          if (event.type === 'contentDelta' && typeof event.text === 'string') {
            rawText += event.text
          } else if (event.type === 'completionDone') {
            break
          }
        }
      } else if (typeof result === 'string') {
        rawText = result
      }
    } catch (err) {
      state.failureCount += 1
      state.lastError = err && err.message
      emit('goalcard:error', {
        code: 'CONSUME_FAILED', message: err && err.message
      })
      return { ok: false, reason: 'consume_failed' }
    }

    if (!rawText || rawText.length === 0) {
      state.failureCount += 1
      emit('goalcard:error', { code: 'EMPTY_OUTPUT', message: 'model returned no text' })
      return { ok: false, reason: 'empty_output' }
    }

    const parsed = extractJsonObject(rawText)
    if (!parsed) {
      state.failureCount += 1
      emit('goalcard:error', { code: 'JSON_PARSE', message: 'no valid JSON object in output' })
      return { ok: false, reason: 'json_parse_failed' }
    }

    const validation = validateCard(parsed)
    if (!validation.ok) {
      state.failureCount += 1
      emit('goalcard:error', { code: 'VALIDATION', message: validation.reason })
      return { ok: false, reason: validation.reason }
    }

    state.successCount += 1
    emit('goalcard:parsed', {
      minute: validation.card.minute,
      scorer: validation.card.scorer,
      team: validation.card.team
    })
    log('info', 'goalCard parsed', {
      minute: validation.card.minute, team: validation.card.team
    })
    return { ok: true, card: validation.card }
  }

  function status () {
    return {
      ready: !!resolveHandle(),
      parseCount: state.parseCount,
      successCount: state.successCount,
      failureCount: state.failureCount,
      lastError: state.lastError,
      flagEnabled: goalCardFlagEnabled()
    }
  }

  async function close () {
    state.destroyed = true
  }

  return { parse, status, close, _internal: { state, extractJsonObject, validateCard, sanitiseInput } }
}

module.exports = {
  createGoalCard,
  goalCardFlagEnabled,
  extractJsonObject,
  validateCard,
  sanitiseInput,
  GOAL_CARD_SCHEMA,
  SYSTEM_PROMPT,
  MAX_INPUT_CHARS,
  MAX_OUTPUT_CHARS
}
