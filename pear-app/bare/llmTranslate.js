// Curva QVAC LLM-fallback translator (Wave 16).
//
// Purpose: when the Bergamot NMT engine (bare/translate.js) is disabled or a
// specific pair failed to load (e.g. because the vocab file didn't download,
// or the pair isn't in DEFAULT_PAIRS), fall back to prompting Qwen3 0.6B Q4
// with a strict "translate this" template. Same SDK, same on-device path,
// slower but no separate model artefacts required.
//
// Docs-verification memo ----------------------------------------------------
//
// Source of truth: pear-app/node_modules/@qvac/sdk 0.14.0.
//   - dist/client/api/completion-stream.d.ts:105
//     `export declare function completion(params: CompletionParams): CompletionRun`
//     History shape: Array<{role:'system'|'user'|'assistant', content:string}>
//     Return: `{ events, final, tokenStream?, text?, ... }`.
//   - dist/models/registry/models.js:2079-2093 QWEN3_600M_INST_Q4 constant.
//   - Reuse of translate.js loadSdkLlm({modelSrc, modelConfig?, onProgress?})
//     which returns `{modelId, completion, unloadModel}` — already unit-tested
//     via commentator.js.
//
// Rationale: chat messages are 1-2 short sentences, so we drive stream:false
// and read `result.text` for a single Promise<string>. No per-token UI on the
// LLM fallback path — the value-add is correctness, not latency.
//
// Feature flag: CURVA_QVAC_LLM_TRANSLATE_ENABLED (defaults to "1"/true). Off
// = fallback disabled and the chat message stays in the source language when
// Bergamot can't cover the pair.

const { loadSdkLlm } = require('./translate.js')

const QWEN3_MODEL_ID = 'QWEN3_600M_INST_Q4'
const DEFAULT_TIMEOUT_MS = 20_000

const LANG_NAME = Object.freeze({
  en: 'English',
  it: 'Italian',
  id: 'Indonesian',
  es: 'Spanish',
  pt: 'Portuguese',
  de: 'German',
  fr: 'French',
  ja: 'Japanese',
  zh: 'Chinese',
  ar: 'Arabic'
})

function langLabel (code) {
  const c = String(code || '').toLowerCase()
  return LANG_NAME[c] || c.toUpperCase() || 'the target language'
}

function flagEnabled () {
  const raw = typeof process !== 'undefined' && process.env
    ? process.env.CURVA_QVAC_LLM_TRANSLATE_ENABLED
    : undefined
  if (raw === undefined || raw === null || raw === '') return true
  const s = String(raw).toLowerCase()
  return !(s === '0' || s === 'false' || s === 'no' || s === 'off')
}

/**
 * Build the translation prompt. Kept small so a 0.6B model doesn't wander.
 * The system message forces "output only the translation" — critical because
 * Qwen3 loves to explain itself, and any leading "Sure, here you go:" would
 * ship into the chat row.
 */
function buildMessages ({ text, from, to }) {
  const src = langLabel(from)
  const dst = langLabel(to)
  return [
    {
      role: 'system',
      content:
        'You translate short chat messages from one language to another. ' +
        'Output only the translated text with no quotes, no prefix, no explanation, ' +
        'no source-language echo, and no trailing punctuation you did not add. ' +
        'If the input is already in the target language, echo it back unchanged. ' +
        'Never refuse.'
    },
    {
      role: 'user',
      content: `Translate this ${src} message into ${dst}:\n\n${text}`
    }
  ]
}

/**
 * Strip common wrappers Qwen3 sometimes emits despite the system prompt.
 * Belt-and-suspenders: the model IS good enough to obey most of the time,
 * but hardening the output beats a post-demo bug report.
 */
function cleanOutput (raw) {
  if (typeof raw !== 'string') return ''
  let s = raw.trim()
  // Strip surrounding matching quotes (straight or curly).
  const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']]
  for (const [open, close] of pairs) {
    if (s.startsWith(open) && s.endsWith(close) && s.length > 1) {
      s = s.slice(open.length, s.length - close.length).trim()
      break
    }
  }
  // Strip common preambles.
  const preambles = [
    /^translation\s*:\s*/i,
    /^translated\s*:\s*/i,
    /^here'?s the translation\s*:\s*/i,
    /^sure[,!]?\s*here'?s.*?:\s*/i
  ]
  for (const re of preambles) s = s.replace(re, '')
  // Drop everything after the first newline (single-message translations).
  const nlIdx = s.indexOf('\n')
  if (nlIdx > 0) s = s.slice(0, nlIdx).trim()
  return s
}

/**
 * @param {{
 *   loadSdkLlmImpl?: typeof loadSdkLlm,
 *   modelSrc?: any,                // override Qwen3 constant for tests
 *   onLoadProgress?: (ev: any) => void,
 *   onStatus?: (ev: any) => void,
 *   timeoutMs?: number
 * }} opts
 */
async function createLlmTranslator (opts = {}) {
  const {
    loadSdkLlmImpl = loadSdkLlm,
    modelSrc = QWEN3_MODEL_ID,
    onLoadProgress = () => {},
    onStatus = () => {},
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = opts

  if (!flagEnabled()) {
    return makeDisabled('CURVA_QVAC_LLM_TRANSLATE_ENABLED=false')
  }

  let handle = null
  let loading = null

  async function ensureLoaded () {
    if (handle) return handle
    if (loading) return loading
    loading = (async () => {
      try {
        onStatus({ phase: 'load-start', modelSrc })
        const h = await loadSdkLlmImpl({
          modelSrc,
          onProgress: (p) => onLoadProgress(p)
        })
        if (!h) {
          onStatus({ phase: 'load-failed', reason: 'SDK LLM plugin unavailable' })
          return null
        }
        handle = h
        onStatus({ phase: 'ready', modelId: h.modelId })
        return h
      } catch (err) {
        onStatus({ phase: 'load-failed', reason: err?.message || 'load failed' })
        return null
      } finally {
        loading = null
      }
    })()
    return loading
  }

  async function translate ({ text, from, to } = {}) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new RangeError('text must be a non-empty string')
    }
    if (typeof from !== 'string' || typeof to !== 'string') {
      throw new TypeError('from and to must be lang codes')
    }
    if (from === to) return text

    const h = await ensureLoaded()
    if (!h) {
      const err = new Error('LLM translator unavailable')
      err.code = 'LLM_UNAVAILABLE'
      throw err
    }

    const messages = buildMessages({ text, from, to })
    const runPromise = (async () => {
      // Prefer stream:false + text Promise (chat lines are short; per-token UI
      // isn't worth the complexity for the fallback path).
      const run = h.completion({
        modelId: h.modelId,
        history: messages,
        stream: false
      })
      // Docs surface either .text (Promise<string>) or .final ({content}).
      // Handle both defensively — versions of the SDK have shipped both shapes.
      if (run && typeof run.text?.then === 'function') {
        return await run.text
      }
      if (run && typeof run.final?.then === 'function') {
        const final = await run.final
        if (final && typeof final.content === 'string') return final.content
        if (final && typeof final.text === 'string') return final.text
      }
      if (run && typeof run.tokenStream?.[Symbol.asyncIterator] === 'function') {
        let buf = ''
        for await (const tok of run.tokenStream) {
          buf += typeof tok === 'string' ? tok : String(tok ?? '')
          if (buf.length > 800) break // hard cap
        }
        return buf
      }
      throw new Error('LLM completion returned no recognised text surface')
    })()

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        const err = new Error(`LLM translate timed out after ${timeoutMs}ms`)
        err.code = 'LLM_TIMEOUT'
        reject(err)
      }, timeoutMs)
    })

    const raw = await Promise.race([runPromise, timeoutPromise])
    const cleaned = cleanOutput(raw)
    if (!cleaned) {
      const err = new Error('LLM translate returned empty string')
      err.code = 'LLM_EMPTY'
      throw err
    }
    return cleaned
  }

  async function close () {
    const h = handle
    handle = null
    if (h && typeof h.unloadModel === 'function') {
      try { await h.unloadModel({ modelId: h.modelId }) } catch { /* noop */ }
    }
  }

  return {
    translate,
    close,
    status () {
      return {
        mode: handle ? 'ready' : (loading ? 'loading' : 'idle'),
        modelId: handle?.modelId || null
      }
    },
    _internal: { ensureLoaded }
  }
}

function makeDisabled (reason) {
  return {
    translate: async () => {
      const err = new Error(reason || 'LLM translator disabled')
      err.code = 'LLM_DISABLED'
      throw err
    },
    close: async () => {},
    status: () => ({ mode: 'disabled', reason: reason || null }),
    _internal: {}
  }
}

module.exports = {
  createLlmTranslator,
  _internal: { buildMessages, cleanOutput, langLabel, flagEnabled }
}
