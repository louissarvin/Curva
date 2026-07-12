// Curva VLM match-frame captioning (Cup Final feature A).
//
// Docs (WebFetch/read date 2026-07-10, cited in comments below):
//   - https://docs.qvac.tether.io/ai-capabilities/multimodal/
//     Multimodal loadModel + completion({history:[{role,content,attachments:[{path}]}]})
//     with a required projectionModelSrc via modelConfig.
//   - https://docs.qvac.tether.io/ai-capabilities/text-generation/
//     Completion result exposes `events` (canonical async iterator of typed
//     events: contentDelta / completionStats / completionDone).
//   - https://docs.qvac.tether.io/ai-capabilities/classification/
//     ggml-classification addon: `sdk.loadModel({modelType:'ggml-classification'})`
//     returns a modelId; `sdk.classify({modelId, image, topK})` returns
//     `[{label, confidence}]` sorted descending. Bundled MobileNetV3-Small emits
//     the three labels: "food" | "report" | "other".
//   - https://docs.qvac.tether.io/reference/api/  (SDK reference)
//
// Ground truth (installed @qvac/sdk 0.14.0):
//   - node_modules/@qvac/sdk/dist/client/api/classify.d.ts:22
//       classify(params: ClassifyClientParams): Promise<ClassificationResult[]>
//   - Same file, JSDoc lines 4-6: MobileNetV3-Small produces "food"/"report"/"other".
//
// Wave 4 feature F1 (pre-filter): every N-th captured frame is first pushed
// through the cheap MobileNetV3-Small classifier. If the top confidence is low
// OR the top label is "food" (definitionally off-topic for football), we skip
// the expensive SmolVLM2 caption and emit `vlm:pre-filter-skip`. This is a
// hard cost reducer — SmolVLM2 completion is ~100x the classify cost. The
// pre-filter is off by default and gated behind CURVA_VLM_PREFILTER_ENABLED so
// existing callers see identical behavior.
//
// Ground truth (installed @qvac/sdk 0.14.0):
//   - pear-app/node_modules/@qvac/sdk/dist/schemas/completion-stream.d.ts
//       attachmentSchema = { path: string }        (line 23-25)
//       history entries carry `attachments?: [{path}]` (line 55-58)
//       CompletionStreamResponse.events yields typed frames including
//       contentDelta {seq, text}, completionStats {stats}, completionDone.
//   - pear-app/node_modules/@qvac/sdk/dist/client/api/completion-stream.d.ts
//       `completion(params).events` is the documented canonical stream.
//   - pear-app/node_modules/@qvac/sdk/dist/models/registry/models.js:835
//       SMOLVLM2_500M_MULTIMODAL_Q8_0 modelSrc constant.
//     ...:803 MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0.
//
// Trust posture (ARCHITECTURE.md Section 2.6, 12.2 — Curva companion, not
// source of truth): captioning is a nice-to-have. Any failure disables the
// feature for that call and returns `{ok:false, reason}` — never throws to the
// UI. Model load failures are surfaced via `vlm:error` events for observability.
//
// Security defense-in-depth (OWASP Input Validation + LLM01 Prompt Injection):
//   - The USER cannot inject a prompt — the prompt is a fixed template.
//   - The MODEL output is sanitized before it becomes chat text: control chars
//     stripped, length-capped, and any leading role-marker tokens
//     (system:/user:/tool:) removed so a hostile caption can't impersonate a
//     system message when it's fed into RAG or the room bot downstream.

function _tryRequire (bareId, nodeId) {
  try { return require(bareId) } catch { return require(nodeId) }
}
const path = _tryRequire('bare-path', 'path')
const fs = _tryRequire('bare-fs', 'fs')
const os = _tryRequire('bare-os', 'os')
const crypto = _tryRequire('bare-crypto', 'crypto')

// Caps. Enforced regardless of caller-supplied opts.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024        // 10 MB
const MAX_PROMPT_CHARS = 512
const MAX_CAPTION_CHARS = 1024
const DEFAULT_PROMPT =
  'Describe this football scene in one factual sentence. ' +
  'Focus on players, ball position, and pitch area.'

// SDK constant names (see docs-verification memo above). We accept either the
// full descriptor object OR a string name; production wiring uses the imported
// descriptor from `@qvac/sdk` (registry constants).
const DEFAULT_MODEL_SRC_NAME = 'SMOLVLM2_500M_MULTIMODAL_Q8_0'
const DEFAULT_PROJECTION_NAME = 'MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0'

// F1: pre-filter defaults. MobileNetV3-Small classifier thresholds.
const PREFILTER_MIN_CONFIDENCE = 0.4
const PREFILTER_SKIP_LABELS = new Set(['food'])
const PREFILTER_TOP_K = 3

/**
 * Read the pre-filter feature flag. Only "true" (case-insensitive) enables.
 * Any other value, or an unset env, keeps the pre-filter off so existing
 * callers see identical behavior. Never throws.
 */
function prefilterEnabled () {
  try {
    if (typeof process === 'undefined' || !process.env) return false
    return String(process.env.CURVA_VLM_PREFILTER_ENABLED || '').toLowerCase() === 'true'
  } catch { return false }
}

/**
 * @typedef {Object} VlmCaptionResult
 * @property {boolean} ok
 * @property {string} [caption]
 * @property {string} [reason]
 * @property {string} [code]
 * @property {number} [durationMs]
 */

/**
 * @param {{
 *   sdk?: any,                // injected @qvac/sdk-compatible object (test seam)
 *   sdkImpl?: () => Promise<any>, // async factory (prod path resolves @qvac/sdk)
 *   modelSrc?: any,           // descriptor or string
 *   projectionModelSrc?: any, // descriptor or string
 *   tmpDir?: string,          // where Buffer inputs get written before load
 *   log?: (msg, extras?) => void,
 *   emit?: (event: string, payload: any) => void
 * }} opts
 */
function createVlmCaption (opts = {}) {
  const {
    sdk: injectedSdk = null,
    sdkImpl = null,
    modelSrc = DEFAULT_MODEL_SRC_NAME,
    projectionModelSrc = DEFAULT_PROJECTION_NAME,
    tmpDir = null,
    log = () => {},
    emit = () => {}
  } = opts

  let sdk = injectedSdk
  let modelId = null
  let loading = null // Promise<modelId>|null while loading is in-flight
  let closed = false
  let lastError = null

  // F1 pre-filter state. Lazily initialized on first prefilter call.
  let classifierModelId = null
  let classifierLoading = null
  let classifierLoadFailed = false
  // Counters exposed via status() so DiagnosticsPanel can render
  // vlm_frames_saved_total{reason=...} from a Prometheus-compatible source.
  const prefilterCounters = { passed: 0, skippedLowConf: 0, skippedLabel: 0, error: 0 }

  async function resolveSdk () {
    if (sdk) return sdk
    if (typeof sdkImpl === 'function') {
      sdk = await sdkImpl()
      return sdk
    }
    // Production import path. Mirrors bare/translate.js resolveEngine() so a
    // missing/broken SDK degrades gracefully.
    try {
      const mod = await import('@qvac/sdk')
      sdk = mod
      return sdk
    } catch (err) {
      throw withCode('SDK_UNAVAILABLE', `@qvac/sdk import failed: ${err?.message || err}`)
    }
  }

  async function ensureLoaded () {
    if (closed) throw withCode('CLOSED', 'vlm caption module closed')
    if (modelId) return modelId
    if (loading) return loading
    loading = (async () => {
      const s = await resolveSdk()
      if (typeof s.loadModel !== 'function' || typeof s.completion !== 'function') {
        throw withCode('SDK_MISSING_EXPORTS', 'SDK is missing loadModel/completion')
      }
      emit('vlm:loading', { modelSrc: descriptorName(modelSrc) })
      try {
        // Resolve string constant names to the actual SDK descriptor object.
        // The SDK exports SMOLVLM2_500M_MULTIMODAL_Q8_0 etc. as descriptors on
        // its top-level namespace; loadModel expects the descriptor (with
        // registrySource + registryPath + expectedSize), NOT the string name.
        // Passing the raw string triggers `Failed to load model: Model with
        // ID "SMOLVLM2_500M_MULTIMODAL_Q8_0". Available models: [...]`
        // because the SDK's model resolver walks the model list looking for
        // matching gguf filenames rather than constant identifiers.
        // Verified against @qvac/sdk 0.14.0 dist/models/registry/models.js.
        const resolvedModelSrc = (typeof modelSrc === 'string' && s[modelSrc] !== undefined) ? s[modelSrc] : modelSrc
        const resolvedProjection = (typeof projectionModelSrc === 'string' && s[projectionModelSrc] !== undefined) ? s[projectionModelSrc] : projectionModelSrc
        const id = await s.loadModel({
          modelSrc: resolvedModelSrc,
          modelType: 'llm',
          modelConfig: {
            // Multimodal completion needs the vision projection model.
            // Docs: https://docs.qvac.tether.io/ai-capabilities/multimodal/
            // ("You must load a multimodal-capable LLM AND its matching
            // projectionModelSrc").
            projectionModelSrc: resolvedProjection,
            ctx_size: 1024
          },
          onProgress: (p) => {
            if (p && typeof p === 'object') {
              const percent = Number(p.percentage) || (p.total ? Math.round(p.downloaded / p.total * 100) : null)
              emit('vlm:progress', { p: percent, downloaded: p.downloaded, total: p.total })
            }
          }
        })
        modelId = id
        emit('vlm:loaded', { modelId })
        return id
      } catch (err) {
        lastError = err
        emit('vlm:error', { code: err?.code || 'LOAD_FAILED', message: err?.message || String(err) })
        throw err
      } finally {
        loading = null
      }
    })()
    return loading
  }

  /**
   * F1: ensure the MobileNetV3 classifier model is loaded. Only called when
   * the pre-filter feature flag is on. Cached across calls; a single failure
   * disables the pre-filter for the rest of the process lifetime so a broken
   * classifier never blocks captioning.
   */
  async function ensureClassifierLoaded () {
    if (closed) throw withCode('CLOSED', 'vlm caption module closed')
    if (classifierModelId) return classifierModelId
    if (classifierLoadFailed) return null
    if (classifierLoading) return classifierLoading
    classifierLoading = (async () => {
      const s = await resolveSdk()
      if (typeof s.loadModel !== 'function' || typeof s.classify !== 'function') {
        classifierLoadFailed = true
        return null
      }
      try {
        // Per classify.d.ts:15 example, loadModel({modelType:'ggml-classification'})
        // returns the modelId for the bundled MobileNetV3-Small model.
        const id = await s.loadModel({ modelType: 'ggml-classification' })
        classifierModelId = id
        emit('vlm:pre-filter-loaded', { modelId: id })
        return id
      } catch (err) {
        classifierLoadFailed = true
        emit('vlm:pre-filter-error', { code: err?.code || 'CLASSIFIER_LOAD_FAILED', message: err?.message || String(err) })
        return null
      } finally {
        classifierLoading = null
      }
    })()
    return classifierLoading
  }

  /**
   * F1: run the cheap MobileNetV3-Small classifier and decide whether the
   * frame is worth sending to SmolVLM2.
   *
   * @param {Uint8Array|Buffer} imageBuffer  raw JPEG/PNG bytes
   * @returns {Promise<{shouldCaption:boolean, reason:string, topLabel:string|null, topConfidence:number}>}
   */
  async function preFilter (imageBuffer) {
    if (!imageBuffer || (typeof imageBuffer !== 'object' && !Buffer.isBuffer?.(imageBuffer))) {
      // Path-only inputs cannot be pre-filtered without reading them first.
      // Fail open — pass through to VLM. This preserves back-compat for
      // callers that pass file paths.
      return { shouldCaption: true, reason: 'no-buffer', topLabel: null, topConfidence: 0 }
    }
    const classifierId = await ensureClassifierLoaded()
    if (!classifierId) {
      // Classifier unavailable — fail open. VLM gate is only a cost saver, not
      // a correctness gate; we must not drop frames on infra failure.
      return { shouldCaption: true, reason: 'classifier-unavailable', topLabel: null, topConfidence: 0 }
    }
    const s = await resolveSdk()
    let results
    try {
      // ClassifyClientParams (classify.d.ts:1 + schemas): {modelId, image, topK}
      // image accepts a JPEG/PNG buffer (Uint8Array) directly.
      const image = imageBuffer instanceof Uint8Array
        ? imageBuffer
        : new Uint8Array(imageBuffer.buffer, imageBuffer.byteOffset || 0, imageBuffer.byteLength)
      results = await s.classify({ modelId: classifierId, image, topK: PREFILTER_TOP_K })
    } catch (err) {
      prefilterCounters.error += 1
      emit('vlm:pre-filter-error', { code: err?.code || 'CLASSIFY_FAILED', message: err?.message || String(err) })
      // Fail open on classifier errors.
      return { shouldCaption: true, reason: 'classifier-error', topLabel: null, topConfidence: 0 }
    }
    if (!Array.isArray(results) || results.length === 0) {
      return { shouldCaption: true, reason: 'empty-results', topLabel: null, topConfidence: 0 }
    }
    // Per classify.d.ts:11 results are sorted highest-first.
    const top = results[0] || {}
    const topLabel = typeof top.label === 'string' ? top.label : null
    const topConfidence = Number.isFinite(top.confidence) ? top.confidence : 0

    if (topConfidence < PREFILTER_MIN_CONFIDENCE) {
      return {
        shouldCaption: false,
        reason: 'low-confidence',
        topLabel,
        topConfidence
      }
    }
    if (topLabel && PREFILTER_SKIP_LABELS.has(topLabel.toLowerCase())) {
      return {
        shouldCaption: false,
        reason: 'off-topic-label',
        topLabel,
        topConfidence
      }
    }
    return { shouldCaption: true, reason: 'pass', topLabel, topConfidence }
  }

  /**
   * Produce a caption for one image.
   *
   * @param {string|Buffer|Uint8Array} imageInput
   *   File-system path (string) OR image bytes (Buffer / Uint8Array). Bytes
   *   are written to a tmp file before being passed as `attachments:[{path}]`
   *   because the SDK schema (schemas/completion-stream.d.ts:23-25) only
   *   accepts `{path}` attachments.
   * @param {{ prompt?: string, maxImageBytes?: number, signal?: AbortSignal, usePreFilter?: boolean }} [opts2]
   * @returns {Promise<VlmCaptionResult>}
   */
  async function caption (imageInput, opts2 = {}) {
    const startedAt = nowMs()
    try {
      const { prompt = DEFAULT_PROMPT, maxImageBytes = MAX_IMAGE_BYTES } = opts2

      // F1 pre-filter gate. Runs only when caller opts in (default true) AND
      // the feature flag is on. Path-only inputs are not pre-filtered (see
      // preFilter comment: fail-open behavior).
      const wantsPrefilter = opts2.usePreFilter !== false && prefilterEnabled()
      if (wantsPrefilter && typeof imageInput !== 'string') {
        const pf = await preFilter(imageInput)
        if (!pf.shouldCaption) {
          if (pf.reason === 'low-confidence') prefilterCounters.skippedLowConf += 1
          else if (pf.reason === 'off-topic-label') prefilterCounters.skippedLabel += 1
          emit('vlm:pre-filter-skip', {
            reason: pf.reason,
            topLabel: pf.topLabel,
            topConfidence: pf.topConfidence
          })
          return { ok: false, code: 'PRE_FILTER', reason: pf.reason, topLabel: pf.topLabel, topConfidence: pf.topConfidence }
        }
        prefilterCounters.passed += 1
        emit('vlm:pre-filter-passed', { topLabel: pf.topLabel, topConfidence: pf.topConfidence })
      }

      // Input validation. Reject at the boundary — never let the SDK or the
      // filesystem get raw untrusted input.
      const cleanPrompt = sanitizePrompt(prompt)
      if (!cleanPrompt) {
        return { ok: false, code: 'BAD_PROMPT', reason: 'prompt is empty after sanitization' }
      }
      if (cleanPrompt.length > MAX_PROMPT_CHARS) {
        return { ok: false, code: 'PROMPT_TOO_LONG', reason: `prompt > ${MAX_PROMPT_CHARS} chars` }
      }

      const { filePath, cleanup } = await materializeImage(imageInput, {
        maxBytes: Math.min(maxImageBytes, MAX_IMAGE_BYTES),
        tmpDir
      })

      try {
        const id = await ensureLoaded()
        const s = await resolveSdk()

        // Build the completion call. Shape verified against
        // schemas/completion-stream.d.ts (attachmentSchema:23 + history:52-58).
        const run = s.completion({
          modelId: id,
          history: [
            { role: 'user', content: cleanPrompt, attachments: [{ path: filePath }] }
          ],
          stream: true,
          // Small and deterministic-ish so we don't drift into hallucination.
          generationParams: { temp: 0.2, top_p: 0.9, predict: 96 }
        })

        // Consume `events` (canonical per client/api/completion-stream.d.ts).
        // Fall back to `tokenStream` (legacy alias) if a test SDK only
        // provides that.
        let full = ''
        if (run && run.events && typeof run.events[Symbol.asyncIterator] === 'function') {
          for await (const ev of run.events) {
            if (!ev || typeof ev !== 'object') continue
            if (ev.type === 'contentDelta' && typeof ev.text === 'string') {
              full += ev.text
              emit('vlm:caption-token', { text: ev.text })
              if (full.length > MAX_CAPTION_CHARS * 2) break // hard runaway guard
            } else if (ev.type === 'completionDone') {
              break
            }
          }
        } else if (run && run.tokenStream && typeof run.tokenStream[Symbol.asyncIterator] === 'function') {
          for await (const tok of run.tokenStream) {
            const t = typeof tok === 'string' ? tok : (tok?.text || '')
            if (!t) continue
            full += t
            emit('vlm:caption-token', { text: t })
            if (full.length > MAX_CAPTION_CHARS * 2) break
          }
        } else if (run && run.text && typeof run.text.then === 'function') {
          full = await run.text
        } else {
          return { ok: false, code: 'NO_STREAM', reason: 'SDK completion() returned no consumable surface' }
        }

        const clean = sanitizeCaption(full)
        if (!clean) {
          return { ok: false, code: 'EMPTY_CAPTION', reason: 'model returned no usable text' }
        }
        return { ok: true, caption: clean, durationMs: Math.round(nowMs() - startedAt) }
      } finally {
        try { cleanup() } catch { /* noop */ }
      }
    } catch (err) {
      lastError = err
      emit('vlm:error', { code: err?.code || 'CAPTION_FAILED', message: err?.message || String(err) })
      return { ok: false, code: err?.code || 'CAPTION_FAILED', reason: err?.message || 'caption failed' }
    }
  }

  async function close () {
    closed = true
    if (modelId && sdk && typeof sdk.unloadModel === 'function') {
      try { await sdk.unloadModel({ modelId }) } catch { /* noop */ }
    }
    // Also unload the classifier — cheap but still uses memory in the SDK
    // worker. Best-effort; a failing unload cannot re-throw here.
    if (classifierModelId && sdk && typeof sdk.unloadModel === 'function') {
      try { await sdk.unloadModel({ modelId: classifierModelId }) } catch { /* noop */ }
    }
    modelId = null
    classifierModelId = null
  }

  function status () {
    return {
      ready: !!modelId,
      loading: !!loading,
      closed,
      lastError: lastError ? (lastError.code || 'ERROR') : null,
      // F1 counters. DiagnosticsPanel reads these to render
      // vlm_frames_saved_total{reason=...}. Snapshot copy so callers cannot
      // mutate our internal state.
      prefilter: {
        enabled: prefilterEnabled(),
        classifierReady: !!classifierModelId,
        classifierFailed: classifierLoadFailed,
        passed: prefilterCounters.passed,
        skippedLowConf: prefilterCounters.skippedLowConf,
        skippedLabel: prefilterCounters.skippedLabel,
        error: prefilterCounters.error
      }
    }
  }

  return {
    caption,
    close,
    status,
    // Exposed for observability wiring + tests. Not part of the stable API
    // surface for room bot callers.
    preFilter,
    _internal: {
      get modelId () { return modelId },
      get classifierModelId () { return classifierModelId }
    }
  }
}

// -- Helpers ------------------------------------------------------------------

/**
 * Materialize the caller's image input to an on-disk path. If a string path is
 * given we validate it exists and is under the byte cap; otherwise we write
 * the bytes to a random tmp file. Callers MUST invoke the returned cleanup.
 *
 * @param {string|Buffer|Uint8Array} input
 * @param {{ maxBytes: number, tmpDir?: string|null }} opts
 * @returns {Promise<{filePath: string, cleanup: () => void}>}
 */
async function materializeImage (input, { maxBytes, tmpDir }) {
  if (typeof input === 'string') {
    // Path input. Verify it exists and is under the cap.
    let stat
    try { stat = fs.statSync(input) } catch (err) {
      throw withCode('IMAGE_NOT_FOUND', `image path not readable: ${err.message}`)
    }
    if (!stat.isFile()) throw withCode('IMAGE_NOT_FILE', 'image path is not a regular file')
    if (stat.size > maxBytes) {
      throw withCode('IMAGE_TOO_LARGE', `image size ${stat.size} exceeds cap ${maxBytes}`)
    }
    // Path traversal defense: resolve to absolute so downstream never sees a
    // relative path that could escape a chroot. The SDK loads by absolute path.
    return { filePath: path.resolve(input), cleanup: () => {} }
  }

  // Buffer / Uint8Array. Write to a random tmp file.
  const bytes = input instanceof Uint8Array ? input : (input && input.buffer ? new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength) : null)
  if (!bytes) throw withCode('BAD_IMAGE_INPUT', 'image input must be a path, Buffer, or Uint8Array')
  if (bytes.byteLength > maxBytes) {
    throw withCode('IMAGE_TOO_LARGE', `image size ${bytes.byteLength} exceeds cap ${maxBytes}`)
  }
  const dir = tmpDir || (os?.tmpdir?.() || '/tmp')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* best effort */ }
  const rand = randomHex(16)
  const ext = sniffExt(bytes) || 'bin'
  const filePath = path.join(dir, `curva-vlm-${rand}.${ext}`)
  fs.writeFileSync(filePath, Buffer.isBuffer ? Buffer.from(bytes) : bytes)
  return {
    filePath,
    cleanup: () => { try { fs.unlinkSync(filePath) } catch { /* noop */ } }
  }
}

function sniffExt (bytes) {
  if (!bytes || bytes.length < 4) return null
  // PNG 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  // JPEG FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  // WebP RIFF....WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'webp'
  return null
}

function randomHex (n) {
  if (crypto?.randomBytes) return crypto.randomBytes(n).toString('hex')
  // Deterministic-ish fallback for bare runtimes without crypto.randomBytes.
  let s = ''
  for (let i = 0; i < n * 2; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

/**
 * Strip control characters and enforce a hard length cap on the prompt. This
 * is defensive — the prompt is a fixed template today, but a future caller
 * could parameterize it and we want the same hygiene.
 */
function sanitizePrompt (raw) {
  if (typeof raw !== 'string') return ''
  // Remove ASCII control chars except \n / \t.
  let s = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  s = s.trim()
  if (s.length > MAX_PROMPT_CHARS) s = s.slice(0, MAX_PROMPT_CHARS)
  return s
}

/**
 * Sanitize the model output before it becomes chat/RAG text.
 *
 * Defense in depth against LLM01 (prompt injection): a hostile caption could
 * try to impersonate a system/tool message when it's later fed into the room
 * bot's system prompt via RAG. We strip role prefixes, control chars, and
 * anything that looks like a tag block, then cap length.
 */
function sanitizeCaption (raw) {
  if (typeof raw !== 'string') return ''
  let s = raw
  // Remove control chars.
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  // Strip common role-marker prefixes at the start of the string.
  s = s.replace(/^\s*(system|user|assistant|tool)\s*:\s*/i, '')
  // Strip <|...|> chat tokens and <think>/<tool_call> blocks (including
  // contents) defensively — a hostile model might smuggle "system: forget"
  // inside a <think> block that we would otherwise expose to RAG.
  s = s.replace(/<\|[^|>]*\|>/g, '')
  s = s.replace(/<(think|thinking|tool_call|tool)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<\/?(think|thinking|tool_call|tool)>/gi, '')
  s = s.trim()
  if (s.length > MAX_CAPTION_CHARS) s = s.slice(0, MAX_CAPTION_CHARS)
  return s
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
  createVlmCaption,
  DEFAULT_PROMPT,
  MAX_IMAGE_BYTES,
  MAX_PROMPT_CHARS,
  MAX_CAPTION_CHARS,
  // F1 exports
  prefilterEnabled,
  PREFILTER_MIN_CONFIDENCE,
  PREFILTER_SKIP_LABELS,
  _internal: {
    sanitizePrompt,
    sanitizeCaption,
    materializeImage,
    sniffExt
  }
}
