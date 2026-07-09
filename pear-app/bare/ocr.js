// Curva OCR jersey/scoreboard reader (Cup Final feature B).
//
// Docs (WebFetch/read date 2026-07-10):
//   - https://docs.qvac.tether.io/ai-capabilities/ocr/
//     `loadModel({modelSrc: OCR_LATIN, modelType: 'ocr'})` then
//     `ocr({modelId, image, options})` where image is a path or in-memory
//     buffer and options includes `paragraph`.
//   - https://docs.qvac.tether.io/reference/api/
//
// Ground truth (installed @qvac/sdk 0.14.0):
//   - pear-app/node_modules/@qvac/sdk/dist/schemas/ocr.d.ts
//       imageInputSchema is a discriminated union of
//         {type:'base64', value:string} | {type:'filePath', value:string}
//       ocrOptionsSchema: { paragraph?: boolean }
//       ocrTextBlockSchema: { text:string, bbox?:[x,y,w,h], confidence?:number }
//       OCRConfig also carries `defaultRotationAngles?: number[]` and
//       `lowConfidenceThreshold?: number` at loadModel time (config), NOT at
//       per-call ocr() time. That's why we thread rotation into loadModel().
//   - pear-app/node_modules/@qvac/sdk/dist/client/api/ocr.d.ts
//       `ocr({modelId, image: string | Buffer, options?, stream?})` returns
//       `{ blockStream, blocks: Promise<OCRTextBlock[]>, stats }`. Non-streaming
//       is the default and is what we need — jersey numbers and scoreboard
//       clips are small text volumes and the UI wants "one shot, one overlay".
//   - pear-app/node_modules/@qvac/sdk/dist/models/registry/models.js:15277
//       OCR_LATIN modelSrc constant (real sha256Checksum + registry path).
//
// Trust posture (ARCHITECTURE.md 2.6, 12.2): OCR is a nice-to-have. Any error
// yields `{ok:false, reason}` — never throws to the UI.
//
// Security defense-in-depth:
//   - Every returned text block is control-char-stripped.
//   - Total block count is capped at MAX_BLOCKS_RETURNED (32).
//   - Minimum confidence filter defaults to 0.35; caller can raise it but not
//     lower it below 0.
//   - Path traversal defense on string image inputs (path.resolve).

function _tryRequire (bareId, nodeId) {
  try { return require(bareId) } catch { return require(nodeId) }
}
const path = _tryRequire('bare-path', 'path')
const fs = _tryRequire('bare-fs', 'fs')

// Caps.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024   // 10 MB
const MAX_BLOCKS_RETURNED = 32
const MAX_TEXT_CHARS_PER_BLOCK = 256
const DEFAULT_MIN_CONFIDENCE = 0.35
const DEFAULT_ROTATION_ANGLES = [90, 180, 270]

// SDK constant name (registry: models.js:15277 OCR_LATIN).
const DEFAULT_MODEL_SRC_NAME = 'OCR_LATIN'

/**
 * @typedef {Object} OcrBlock
 * @property {string} text
 * @property {[number,number,number,number]} [bbox]
 * @property {number} [confidence]
 */

/**
 * @param {{
 *   sdk?: any,
 *   sdkImpl?: () => Promise<any>,
 *   modelSrc?: any,
 *   defaultRotationAngles?: number[],
 *   log?: (msg, extras?) => void,
 *   emit?: (event: string, payload: any) => void
 * }} opts
 */
function createOcr (opts = {}) {
  const {
    sdk: injectedSdk = null,
    sdkImpl = null,
    modelSrc = DEFAULT_MODEL_SRC_NAME,
    defaultRotationAngles = DEFAULT_ROTATION_ANGLES,
    log = () => {},
    emit = () => {}
  } = opts

  let sdk = injectedSdk
  let modelId = null
  let loading = null
  let closed = false
  let lastError = null

  async function resolveSdk () {
    if (sdk) return sdk
    if (typeof sdkImpl === 'function') {
      sdk = await sdkImpl()
      return sdk
    }
    try {
      const mod = await import('@qvac/sdk')
      sdk = mod
      return sdk
    } catch (err) {
      throw withCode('SDK_UNAVAILABLE', `@qvac/sdk import failed: ${err?.message || err}`)
    }
  }

  async function ensureLoaded () {
    if (closed) throw withCode('CLOSED', 'ocr module closed')
    if (modelId) return modelId
    if (loading) return loading
    loading = (async () => {
      const s = await resolveSdk()
      if (typeof s.loadModel !== 'function' || typeof s.ocr !== 'function') {
        throw withCode('SDK_MISSING_EXPORTS', 'SDK is missing loadModel/ocr')
      }
      emit('ocr:loading', { modelSrc: descriptorName(modelSrc) })
      try {
        // defaultRotationAngles goes on modelConfig at loadModel per
        // schemas/ocr.d.ts (line 10) — NOT on the per-call ocr() options.
        const id = await s.loadModel({
          modelSrc,
          modelType: 'ocr',
          modelConfig: {
            defaultRotationAngles: [...defaultRotationAngles],
            // Low-confidence threshold hint to the recognizer; we STILL filter
            // client-side because plugin behavior can vary.
            lowConfidenceThreshold: DEFAULT_MIN_CONFIDENCE
          },
          onProgress: (p) => {
            if (p && typeof p === 'object') {
              const percent = Number(p.percentage) || (p.total ? Math.round(p.downloaded / p.total * 100) : null)
              emit('ocr:progress', { p: percent, downloaded: p.downloaded, total: p.total })
            }
          }
        })
        modelId = id
        emit('ocr:loaded', { modelId })
        return id
      } catch (err) {
        lastError = err
        emit('ocr:error', { code: err?.code || 'LOAD_FAILED', message: err?.message || String(err) })
        throw err
      } finally {
        loading = null
      }
    })()
    return loading
  }

  /**
   * Run OCR on an image and return the filtered/sanitized text blocks.
   *
   * @param {string|Buffer|Uint8Array} imageInput
   *   Path (string) or bytes (Buffer/Uint8Array). Passed through to
   *   `sdk.ocr({image})` unchanged — the SDK client accepts both per
   *   client/api/ocr.d.ts.
   * @param {{
   *   paragraph?: boolean,
   *   minConfidence?: number,
   *   maxBlocks?: number,
   *   maxImageBytes?: number
   * }} [opts2]
   * @returns {Promise<{ok: true, blocks: OcrBlock[], durationMs: number} | {ok: false, code: string, reason: string}>}
   */
  async function read (imageInput, opts2 = {}) {
    const startedAt = nowMs()
    try {
      const {
        paragraph = false,
        minConfidence = DEFAULT_MIN_CONFIDENCE,
        maxBlocks = MAX_BLOCKS_RETURNED,
        maxImageBytes = MAX_IMAGE_BYTES
      } = opts2

      // Input validation.
      const image = await validateImageInput(imageInput, Math.min(maxImageBytes, MAX_IMAGE_BYTES))

      const id = await ensureLoaded()
      const s = await resolveSdk()

      // Non-streaming: we want the full block list at once, filtered/sanitized
      // before we surface it. Stream mode adds complexity for zero UX win on
      // jersey / scoreboard clips.
      const runOpts = {
        modelId: id,
        image,
        options: { paragraph: !!paragraph }
      }
      const run = s.ocr(runOpts)
      // Client d.ts:29 — `blocks: Promise<OCRTextBlock[]>`.
      const rawBlocks = await (run && run.blocks && typeof run.blocks.then === 'function'
        ? run.blocks
        : Promise.resolve(Array.isArray(run) ? run : (run?.blocks || [])))

      const cap = clampInt(maxBlocks, 1, MAX_BLOCKS_RETURNED)
      const floor = Math.max(0, Math.min(1, Number(minConfidence) || 0))
      const blocks = filterAndSanitize(rawBlocks, floor, cap)

      return { ok: true, blocks, durationMs: Math.round(nowMs() - startedAt) }
    } catch (err) {
      lastError = err
      emit('ocr:error', { code: err?.code || 'READ_FAILED', message: err?.message || String(err) })
      return { ok: false, code: err?.code || 'READ_FAILED', reason: err?.message || 'ocr failed' }
    }
  }

  async function close () {
    closed = true
    if (modelId && sdk && typeof sdk.unloadModel === 'function') {
      try { await sdk.unloadModel({ modelId }) } catch { /* noop */ }
    }
    modelId = null
  }

  function status () {
    return {
      ready: !!modelId,
      loading: !!loading,
      closed,
      lastError: lastError ? (lastError.code || 'ERROR') : null
    }
  }

  return { read, close, status, _internal: { get modelId () { return modelId } } }
}

// -- Helpers ------------------------------------------------------------------

/**
 * Validate the caller's image input. Returns the value we pass through to
 * `sdk.ocr({image})`. Applies size caps and path traversal defense.
 *
 * The SDK client API accepts `string | Buffer` per
 * client/api/ocr.d.ts:8. Uint8Array is coerced to Buffer for byte-input.
 *
 * @param {string|Buffer|Uint8Array} input
 * @param {number} maxBytes
 */
async function validateImageInput (input, maxBytes) {
  if (typeof input === 'string') {
    let stat
    try { stat = fs.statSync(input) } catch (err) {
      throw withCode('IMAGE_NOT_FOUND', `image path not readable: ${err.message}`)
    }
    if (!stat.isFile()) throw withCode('IMAGE_NOT_FILE', 'image path is not a regular file')
    if (stat.size > maxBytes) {
      throw withCode('IMAGE_TOO_LARGE', `image size ${stat.size} exceeds cap ${maxBytes}`)
    }
    return path.resolve(input)
  }
  // Bytes.
  let bytes
  if (input instanceof Uint8Array) bytes = input
  else if (input && typeof input.byteLength === 'number' && input.buffer) {
    bytes = new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength)
  } else if (input && typeof input === 'object' && typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  } else {
    throw withCode('BAD_IMAGE_INPUT', 'image input must be a path, Buffer, or Uint8Array')
  }
  if (bytes.byteLength > maxBytes) {
    throw withCode('IMAGE_TOO_LARGE', `image size ${bytes.byteLength} exceeds cap ${maxBytes}`)
  }
  // Coerce back to Buffer for the SDK client (accepts string | Buffer).
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  return bytes
}

/**
 * Filter blocks by confidence, drop empty ones, control-char-strip the text,
 * and cap the total count. Keeps the highest-confidence blocks first so if
 * the model returned 100 blocks we surface the most trustworthy 32.
 *
 * @param {any[]} rawBlocks
 * @param {number} minConfidence
 * @param {number} maxBlocks
 * @returns {OcrBlock[]}
 */
function filterAndSanitize (rawBlocks, minConfidence, maxBlocks) {
  if (!Array.isArray(rawBlocks)) return []
  const kept = []
  for (const b of rawBlocks) {
    if (!b || typeof b !== 'object') continue
    const text = sanitizeText(b.text)
    if (!text) continue
    const confidence = typeof b.confidence === 'number' ? b.confidence : null
    if (confidence !== null && confidence < minConfidence) continue
    const bbox = Array.isArray(b.bbox) && b.bbox.length === 4 && b.bbox.every((n) => Number.isFinite(n))
      ? [b.bbox[0], b.bbox[1], b.bbox[2], b.bbox[3]]
      : undefined
    kept.push({ text, ...(confidence !== null ? { confidence } : {}), ...(bbox ? { bbox } : {}) })
  }
  // Sort by confidence desc (nulls last) so the top blocks win the cap.
  kept.sort((a, b) => {
    const ac = typeof a.confidence === 'number' ? a.confidence : -Infinity
    const bc = typeof b.confidence === 'number' ? b.confidence : -Infinity
    return bc - ac
  })
  return kept.slice(0, maxBlocks)
}

function sanitizeText (raw) {
  if (typeof raw !== 'string') return ''
  // Strip control chars.
  let s = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  // Collapse runs of whitespace.
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > MAX_TEXT_CHARS_PER_BLOCK) s = s.slice(0, MAX_TEXT_CHARS_PER_BLOCK)
  return s
}

/**
 * Regex-match a scoreboard-style "TEAM_A N - M TEAM_B" or "N:M" from the OCR
 * output. Returns the first match, or null. This is a convenience for the
 * getMatchState MCP tool feed — the real fixture data still comes from
 * football-data.
 *
 * We accept:
 *   "2 - 1", "2-1", "2:1"     (bare numbers)
 *   "MAN 2 - 1 LIV"           (with team abbreviations)
 *
 * @param {OcrBlock[]} blocks
 * @returns {{ home: number, away: number, homeLabel?: string, awayLabel?: string, source: string } | null}
 */
function extractScore (blocks) {
  if (!Array.isArray(blocks)) return null
  // Try longest text first — scoreboard captions like "MAN 2 - 1 LIV" have
  // more signal than a lone "2" from a jersey.
  const sorted = blocks.slice().sort((a, b) => (b.text?.length || 0) - (a.text?.length || 0))
  // Pattern 1: "LABEL_A N - M LABEL_B" (labels optional).
  const p1 = /(?:([A-Z]{2,4})\s+)?(\d{1,2})\s*[-:]\s*(\d{1,2})(?:\s+([A-Z]{2,4}))?/
  for (const b of sorted) {
    const m = p1.exec(b.text || '')
    if (m) {
      const home = Number(m[2])
      const away = Number(m[3])
      if (Number.isFinite(home) && Number.isFinite(away) && home <= 30 && away <= 30) {
        return {
          home,
          away,
          ...(m[1] ? { homeLabel: m[1] } : {}),
          ...(m[4] ? { awayLabel: m[4] } : {}),
          source: b.text
        }
      }
    }
  }
  return null
}

function clampInt (n, min, max) {
  const v = Math.floor(Number(n))
  if (!Number.isFinite(v)) return max
  return Math.max(min, Math.min(max, v))
}

function descriptorName (m) {
  if (!m) return null
  if (typeof m === 'string') return m
  if (typeof m === 'object' && typeof m.name === 'string') return m.name
  return null
}

function withCode (code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function nowMs () {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now()
  } catch { /* noop */ }
  return Date.now()
}

module.exports = {
  createOcr,
  extractScore,
  MAX_IMAGE_BYTES,
  MAX_BLOCKS_RETURNED,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_ROTATION_ANGLES,
  _internal: {
    filterAndSanitize,
    sanitizeText,
    validateImageInput
  }
}
