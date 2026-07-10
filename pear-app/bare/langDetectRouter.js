// Curva Wave 3 F4: langdetect-text auto Bergamot routing.
//
// Docs-verification memo ---------------------------------------------------
//
// Ground truth (installed):
//   pear-app/node_modules/@qvac/langdetect-text/index.d.ts
//     export function detectOne(text: string): Language      // {code, language}
//     export function detectMultiple(text: string, topK?: number):
//         LanguageProbability[]                              // {code, language, probability}
//     export function getLangName(code: string): string | null
//     export function getISO2FromName(name: string): string | null
//
//   pear-app/node_modules/@qvac/langdetect-text/index.js (impl)
//     Uses `tinyld/heavy` under the hood; `detectOne` returns
//     { code: 'und', language: 'Undetermined' } for empty / unrecognisable
//     input. `detectMultiple` returns descending-probability results.
//
// Design:
//   - `createLangDetectRouter({detector, sdk, log, emit})` returns
//     `{ detect(text), close(), status() }`.
//   - `detect(text)` returns `{ lang: 'en'|'it'|'id'|null, confidence: 0..1 }`.
//     `null` means either undetected, below-confidence, or unsupported
//     locale (we only route to Curva's demo trio).
//   - Confidence floor: 0.6 by default (below returns `{lang: null}`).
//   - Emits `langdetect:detected {lang, confidence, textPrefix}` for the
//     DiagnosticsPanel to expose during code review.
//   - Standalone utility: does NOT modify chat.js or translate.js. The
//     coordinator will wire this into the chat send path.

'use strict'

const DEFAULT_CONFIDENCE_FLOOR = 0.6
const SUPPORTED_ROUTING_LOCALES = Object.freeze(new Set(['en', 'it', 'id']))
const MAX_INPUT_CHARS = 4000
const TEXT_PREVIEW_CHARS = 48

function langDetectFlagEnabled () {
  try {
    const raw = (typeof process !== 'undefined' && process.env &&
      process.env.CURVA_LANGDETECT_ENABLED) || ''
    const s = String(raw).toLowerCase()
    return s === '1' || s === 'true' || s === 'yes' || s === 'on'
  } catch { return false }
}

function loadDetector (injected) {
  if (injected && (typeof injected.detectOne === 'function' ||
                   typeof injected.detectMultiple === 'function')) {
    return injected
  }
  try {
    // Node/CJS runtime resolution of @qvac/langdetect-text.
    return require('@qvac/langdetect-text')
  } catch { return null }
}

/**
 * Normalise a raw text for detection. Removes control chars and caps length
 * so a malicious peer cannot send a megabyte of noise to burn CPU.
 */
function normaliseText (text) {
  if (typeof text !== 'string') return ''
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code === 0x0A || code === 0x0D || code === 0x09) { out += ' '; continue }
    if (code < 0x20) continue
    if (code === 0xFEFF) continue
    out += ch
  }
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length > MAX_INPUT_CHARS) out = out.slice(0, MAX_INPUT_CHARS)
  return out
}

/**
 * @param {{
 *   detector?: { detectOne?: Function, detectMultiple?: Function } | null,
 *   confidenceFloor?: number,
 *   supportedLocales?: Set<string> | string[],
 *   log?: (level: string, msg: string, extra?: any) => void,
 *   emit?: (event: string, payload: any) => void
 * }} opts
 */
function createLangDetectRouter (opts = {}) {
  const {
    detector: injected = null,
    confidenceFloor = DEFAULT_CONFIDENCE_FLOOR,
    supportedLocales = null,
    log = () => {},
    emit = () => {}
  } = opts

  const detector = loadDetector(injected)

  const floor = Number.isFinite(confidenceFloor) && confidenceFloor >= 0 && confidenceFloor <= 1
    ? confidenceFloor
    : DEFAULT_CONFIDENCE_FLOOR

  const allowed = supportedLocales
    ? new Set(Array.from(supportedLocales))
    : SUPPORTED_ROUTING_LOCALES

  const state = {
    destroyed: false,
    detectCount: 0,
    matchCount: 0,
    unsupportedCount: 0,
    belowFloorCount: 0,
    lastError: null
  }

  /**
   * Detect language for `text`. Never throws.
   *
   * @param {string} text
   * @returns {{lang: string|null, confidence: number}}
   */
  function detect (text) {
    const nullOut = { lang: null, confidence: 0 }
    if (state.destroyed) return nullOut
    if (!detector) return nullOut
    const clean = normaliseText(text)
    if (clean.length === 0) return nullOut

    state.detectCount += 1

    // Prefer detectMultiple so we can read the confidence directly. Fall back
    // to detectOne + assumed confidence 1.0 only when the multi-result API is
    // unavailable (tests may inject a partial mock).
    let top = null
    let confidence = 0
    try {
      if (typeof detector.detectMultiple === 'function') {
        const results = detector.detectMultiple(clean, 3) || []
        if (results.length > 0) {
          top = String(results[0].code || '').toLowerCase()
          const rawProb = Number(results[0].probability)
          confidence = Number.isFinite(rawProb) ? Math.max(0, Math.min(1, rawProb)) : 0
        }
      } else if (typeof detector.detectOne === 'function') {
        const one = detector.detectOne(clean) || {}
        top = String(one.code || '').toLowerCase()
        // No probability surface -> treat as maximum confidence but log the
        // caveat via status().
        confidence = 1
      }
    } catch (err) {
      state.lastError = err && err.message
      log('warn', 'langdetect detect failed', { message: err && err.message })
      return nullOut
    }

    if (!top || top === 'und') return nullOut

    const preview = clean.length > TEXT_PREVIEW_CHARS
      ? clean.slice(0, TEXT_PREVIEW_CHARS) + '...'
      : clean

    if (confidence < floor) {
      state.belowFloorCount += 1
      emit('langdetect:detected', {
        lang: null, confidence, textPrefix: preview, reason: 'BELOW_FLOOR', raw: top
      })
      return { lang: null, confidence }
    }

    if (!allowed.has(top)) {
      state.unsupportedCount += 1
      emit('langdetect:detected', {
        lang: null, confidence, textPrefix: preview, reason: 'UNSUPPORTED_LOCALE', raw: top
      })
      return { lang: null, confidence }
    }

    state.matchCount += 1
    emit('langdetect:detected', {
      lang: top, confidence, textPrefix: preview
    })
    return { lang: top, confidence }
  }

  function status () {
    return {
      ready: !!detector,
      detectCount: state.detectCount,
      matchCount: state.matchCount,
      unsupportedCount: state.unsupportedCount,
      belowFloorCount: state.belowFloorCount,
      confidenceFloor: floor,
      allowedLocales: Array.from(allowed),
      lastError: state.lastError,
      flagEnabled: langDetectFlagEnabled()
    }
  }

  function close () {
    state.destroyed = true
  }

  return { detect, status, close, _internal: { state, normaliseText, floor, allowed } }
}

module.exports = {
  createLangDetectRouter,
  langDetectFlagEnabled,
  normaliseText,
  DEFAULT_CONFIDENCE_FLOOR,
  SUPPORTED_ROUTING_LOCALES,
  MAX_INPUT_CHARS,
  TEXT_PREVIEW_CHARS
}
