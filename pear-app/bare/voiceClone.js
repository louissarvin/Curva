// Curva Wave 3 F2 (+ QVAC Ship 3 F1): Chatterbox voice-cloned commentator.
//
// Docs-verification memo ----------------------------------------------------
//
// Ground truth (installed):
//   pear-app/node_modules/@qvac/sdk/dist/schemas/text-to-speech.d.ts:2
//     `TTS_CHATTERBOX_LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl',
//                                  'pl', 'tr', 'sv', 'da', 'fi', 'no', 'el',
//                                  'ms', 'sw', 'ar', 'ko', 'he', 'ru', 'zh',
//                                  'hi']`
//     Indonesian (`id`) is NOT in the Chatterbox language set. Ship 3 F1
//     widens Curva's allowlist from EN/IT to the six-language European/Latin
//     safe set (EN, IT, ES, FR, DE, PT). Other locales are refused with a
//     `LOCALE_NOT_SUPPORTED` skip event so the goal pipeline can fall back
//     to Supertonic via announcer.openSpeakStream.
//
//   pear-app/node_modules/@qvac/sdk/dist/schemas/text-to-speech.d.ts:225-261
//     `referenceAudioSrc` accepts either a `string` (file path / registry
//     src) OR a src-descriptor object which includes the optional shape
//     `{ src, blobCoreKey?: string, blobIndex?: number, ... }`. We use the
//     Hyperblob shape so the reference WAV can travel with the room's
//     corestore without a filesystem round-trip.
//
// Docs: https://docs.qvac.tether.io/ai-capabilities/text-to-speech/ (fetched
// 2026-07-10). The docs snippet showing `{blobCoreKey, blobIndex}` for
// `referenceAudioSrc` agrees with the installed .d.ts; nothing more is
// consulted from the network page.
//
// Design:
//   - `createVoiceClone({sdk, sdkImpl, hyperblobs, corestore, log, emit})`
//     returns `{ enroll(pcmOrPath), speak(text, locale), close(), status() }`.
//   - `enroll(pcm)` writes the reference WAV to a Hyperblob, returns the
//     `{blobCoreKey, blobIndex}` pair. Callers persist the pair into the
//     room's Hyperbee (path `curva/voice-clone/host`) so peers can replicate.
//   - `speak(text, locale)` calls the SDK's Chatterbox TTS with the
//     enrolled reference. Locale is validated against ALLOWED_CLONE_LOCALES.
//     Text is sanitised (control-char strip, length cap 800).
//   - Feature-flag `CURVA_VOICE_CLONE_ENABLED=true`. Off by default.

'use strict'

// Dual-runtime module resolution: `bare-*` on Bare, Node's built-ins under
// brittle-node tests. Same discipline used in bare/translate.js and
// bare/clips.js.
function _tryRequire (bareId, nodeId) {
  try { return require(bareId) } catch { return require(nodeId) }
}

/**
 * Read seconds of PCM audio from a canonical RIFF/WAVE header.
 * Returns NaN when the bytes aren't a recognised WAV so callers can fall
 * through to downstream validation. Only tries the standard fmt+data layout
 * (matches what pear-app/renderer/components/VoiceEnrollmentModal.js emits
 * via float32PcmToWav16Bit); anything exotic is treated as unknown.
 * @param {Uint8Array|Buffer} bytes
 * @returns {number} duration in seconds, or NaN
 */
function readWavDurationSeconds (bytes) {
  if (!bytes || bytes.byteLength < 44) return NaN
  const view = bytes instanceof Uint8Array
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new DataView(bytes)
  // 'RIFF' at 0, 'WAVE' at 8 (big-endian ASCII)
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))
  if (riff !== 'RIFF' || wave !== 'WAVE') return NaN
  // byteRate at bytes 28-31 (u32 LE). Data-chunk size = total - 44 for the
  // canonical PCM header layout used by float32PcmToWav16Bit.
  const byteRate = view.getUint32(28, true)
  if (!byteRate) return NaN
  const dataBytes = bytes.byteLength - 44
  if (dataBytes <= 0) return 0
  return dataBytes / byteRate
}

// Ship 3 F1: European/Latin safe set. Verified against the
// TTS_CHATTERBOX_LANGUAGES literal at text-to-speech.d.ts:2 (fetched
// 2026-07-10). All six are members of that Chatterbox-supported list. We
// deliberately stop short of the CJK / Arabic / Cyrillic tail because Curva's
// current room audience is European-facing and Bergamot's translation
// coverage is strongest here.
const ALLOWED_CLONE_LOCALES = Object.freeze(new Set([
  'en', 'it', 'es', 'fr', 'de', 'pt'
]))

// Chatterbox is a TWO-artefact model. Per @qvac/sdk plugin at
// dist/server/bare/plugins/tts-ggml/plugin.js:19, resolveChatterboxConfig
// throws TTS_ARTIFACTS_REQUIRED when modelConfig.s3genModelSrc is missing.
// The T3 GGUF loaded via modelSrc is only half of the pipeline; the S3Gen
// companion generates the mel-to-waveform stage. See the SDK's own example
// at dist/examples/tts/chatterbox.js:10-14 for the canonical call shape.
//
// Registry key discipline: the SDK renamed the multilingual T3 key from the
// old `TTS_CHATTERBOX_MULTILINGUAL_Q8_0` (Ship 3 F1 vintage) to the current
// `TTS_T3_MULTILINGUAL_CHATTERBOX_Q8_0` when it split the T3 / S3Gen pipeline
// into separate registry entries. Using the old key resolves to `undefined`
// off the sdk namespace, falls back to a plain string, and the SDK's model
// resolver rejects with `MODEL_NOT_FOUND` (see the peer log at boot for the
// full "Available models" list — the new T3 name is what actually ships).
// Both constants below live at models.js:16737 (T3) and models.js:16833
// (S3Gen), and are top-level re-exported via
// node_modules/@qvac/sdk/dist/index.js `export * from './models/registry/'`.
const CHATTERBOX_MODEL_SRC_KEY = 'TTS_T3_MULTILINGUAL_CHATTERBOX_Q8_0'
const CHATTERBOX_S3GEN_SRC_KEY = 'TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q8_0'
const CHATTERBOX_MODEL_ID_PREFIX = 'tts-chatterbox'
const CHATTERBOX_SAMPLE_RATE = 24000 // Chatterbox reports 24kHz mono s16 PCM.

const MAX_REFERENCE_BYTES = 4 * 1024 * 1024 // 4 MiB reference WAV cap.
const MAX_TEXT_CHARS = 800

function voiceCloneFlagEnabled () {
  try {
    const raw = (typeof process !== 'undefined' && process.env &&
      process.env.CURVA_VOICE_CLONE_ENABLED) || ''
    const s = String(raw).toLowerCase()
    return s === '1' || s === 'true' || s === 'yes' || s === 'on'
  } catch { return false }
}

/**
 * Strip control characters and cap length. Chatterbox will happily read a
 * multi-thousand-word attacker-supplied string; that path is not something
 * we ever want to expose. This is defence-in-depth on top of the LLM/UI
 * boundary.
 */
function sanitizeText (text) {
  if (typeof text !== 'string') return ''
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
  if (out.length > MAX_TEXT_CHARS) out = out.slice(0, MAX_TEXT_CHARS)
  return out
}

function normaliseLocale (locale) {
  if (typeof locale !== 'string') return null
  const lower = locale.toLowerCase().slice(0, 8)
  return ALLOWED_CLONE_LOCALES.has(lower) ? lower : null
}

/**
 * Chatterbox voice-cloned commentator with a Hyperblob-backed reference clip.
 * A single factory keeps the enrolment path, locale gate, and control-char
 * sanitiser together so the Chatterbox surface never sees unnormalised text.
 *
 * @param {{
 *   sdk?: object | null,           // preloaded @qvac/sdk namespace
 *   sdkImpl?: object | null,       // test seam
 *   hyperblobs?: object | null,    // Hyperblobs instance used for reference storage
 *   corestore?: object | null,     // corestore (used to open a namespaced core for reference blobs)
 *   log?: (level: string, msg: string, extra?: any) => void,
 *   emit?: (event: string, payload: any) => void,
 *   defaultLocale?: 'en'|'it'
 * }} opts
 * @returns {{ enroll: Function, speak: Function, close: Function, status: Function }}
 */
function createVoiceClone (opts = {}) {
  const {
    sdk: injectedSdk = null,
    sdkImpl = null,
    hyperblobs = null,
    corestore = null,
    log = () => {},
    emit = () => {},
    defaultLocale = 'en',
    // Optional local storage dir for a filesystem mirror of the reference WAV.
    // Chatterbox's referenceAudioSrc goes through the SDK's resolveModelPath
    // (node_modules/@qvac/sdk/dist/server/rpc/handlers/load-model/resolve.js)
    // which only understands `registry://`, `http(s)://`, `pear://`, or bare
    // filesystem paths - NOT `hyperblob://`. Curva keeps the Hyperblob write
    // as the P2P replication surface (other peers pull the reference from the
    // room's corestore) AND mirrors the same bytes to a local file so the
    // TTS plugin's TTSInterface constructor can read them. See enroll() below.
    storageDir = null
  } = opts

  const state = {
    destroyed: false,
    ready: false,
    modelIdByLocale: new Map(),
    // { blobCoreKey: hex string, blobIndex: number, filePath: string|null, mimeType, sizeBytes }
    referenceRef: null,
    sdk: null,
    lastError: null,
    defaultLocale: ALLOWED_CLONE_LOCALES.has(defaultLocale) ? defaultLocale : 'en'
  }

  async function loadSdk () {
    if (state.sdk) return state.sdk
    const candidate = sdkImpl || injectedSdk
    if (candidate && typeof candidate.textToSpeech === 'function' &&
        typeof candidate.loadModel === 'function') {
      state.sdk = candidate
      return state.sdk
    }
    try {
      const mod = await import('@qvac/sdk').catch(() => null)
      if (!mod || typeof mod.loadModel !== 'function' ||
          typeof mod.textToSpeech !== 'function') return null
      state.sdk = mod
      return mod
    } catch { return null }
  }

  /**
   * Persist a reference WAV as a Hyperblob and cache the resulting descriptor.
   * Accepts either a Uint8Array/Buffer of WAV bytes OR a string file path
   * (which the caller has already validated to live inside their own dir).
   *
   * @param {Uint8Array|Buffer|string} pcmOrPath
   * @returns {Promise<{blobCoreKey: string, blobIndex: number, sizeBytes: number} | null>}
   */
  async function enroll (pcmOrPath) {
    if (!voiceCloneFlagEnabled()) {
      emit('voiceClone:skip', { reason: 'FLAG_OFF' })
      return null
    }
    if (state.destroyed) return null
    if (!hyperblobs || typeof hyperblobs.put !== 'function') {
      emit('voiceClone:error', {
        code: 'NO_HYPERBLOBS',
        message: 'Hyperblobs instance required for voice enrollment'
      })
      return null
    }

    let bytes
    if (typeof pcmOrPath === 'string') {
      // Filesystem enrolment path. Kept for local debugging; production
      // callers should pass in-memory bytes captured from the mic.
      try {
        const fs = (() => {
          try { return require('bare-fs') } catch { return require('fs') }
        })()
        bytes = fs.readFileSync(pcmOrPath)
      } catch (err) {
        emit('voiceClone:error', {
          code: 'READ_FAILED', message: err && err.message
        })
        return null
      }
    } else if (pcmOrPath instanceof Uint8Array || Buffer.isBuffer(pcmOrPath)) {
      bytes = pcmOrPath
    } else {
      emit('voiceClone:error', {
        code: 'BAD_INPUT',
        message: 'enroll expects Uint8Array/Buffer or filesystem path'
      })
      return null
    }

    if (!bytes || bytes.byteLength === 0) {
      emit('voiceClone:error', { code: 'EMPTY_REFERENCE', message: 'reference audio is empty' })
      return null
    }
    if (bytes.byteLength > MAX_REFERENCE_BYTES) {
      emit('voiceClone:error', {
        code: 'REFERENCE_TOO_LARGE',
        message: 'reference audio exceeds ' + MAX_REFERENCE_BYTES + ' bytes'
      })
      return null
    }
    // Chatterbox validates reference audio duration at model activation:
    //   "--reference-audio is only N.NN s; Chatterbox requires strictly more
    //    than 5 s of clean mono speech. Shorter references produce undersized
    //    conditioning tensors and the model falls back on the built-in voice."
    // Parse the WAV header (RIFF/WAVE) to compute duration up-front so we can
    // reject with a clear code here instead of the opaque FAILED_TO_ACTIVATE
    // surfaced only on the first speak() call. WAV header layout per RIFF spec:
    // bytes 0-3 'RIFF', 8-11 'WAVE', 22-23 numChannels (u16 LE),
    // 24-27 sampleRate (u32 LE), 28-31 byteRate (u32 LE). Data size is the
    // subchunk after 'data' but we approximate with total - 44 for the
    // canonical PCM header (matches what float32PcmToWav16Bit produces on the
    // renderer side). Only inspected when the header magic matches — non-WAV
    // uploads fall through to the SDK's own validation.
    const durationSeconds = readWavDurationSeconds(bytes)
    if (Number.isFinite(durationSeconds) && durationSeconds > 0 && durationSeconds <= 5.0) {
      emit('voiceClone:error', {
        code: 'REFERENCE_TOO_SHORT',
        message: 'reference audio is ' + durationSeconds.toFixed(2) + 's; Chatterbox requires strictly more than 5s of clean mono speech'
      })
      return null
    }

    let blobId
    try {
      // Hyperblobs.put(bytes) returns an id object; the SDK's referenceAudioSrc
      // shape treats this as `blobIndex`. For hyperblobs, id is an object
      // `{ byteOffset, blockOffset, blockLength, byteLength }`. When the SDK
      // expects a bare number, we pass byteOffset (the offset within the
      // underlying hypercore that resolves back to the whole blob). The
      // installed `.d.ts` types `blobIndex` as `number`.
      blobId = await hyperblobs.put(bytes instanceof Uint8Array ? bytes : Buffer.from(bytes))
    } catch (err) {
      emit('voiceClone:error', {
        code: 'BLOB_WRITE_FAILED', message: err && err.message
      })
      return null
    }

    // Extract a numeric handle. Hyperblobs.put returns an object shape;
    // callers on the SDK side that ingest the reference need the blockOffset
    // (used as the primary index into the core). Guard against alt shapes.
    let blobIndex
    if (typeof blobId === 'number') {
      blobIndex = blobId
    } else if (blobId && typeof blobId === 'object') {
      blobIndex = Number.isFinite(blobId.blockOffset) ? blobId.blockOffset
        : Number.isFinite(blobId.byteOffset) ? blobId.byteOffset
          : 0
    } else {
      blobIndex = 0
    }

    let blobCoreKey = null
    try {
      const core = hyperblobs.core
      if (core && core.key) {
        blobCoreKey = Buffer.isBuffer(core.key) ? core.key.toString('hex') : String(core.key)
      }
    } catch { /* noop */ }

    if (!blobCoreKey) {
      emit('voiceClone:error', {
        code: 'BLOB_CORE_KEY_MISSING',
        message: 'hyperblobs.core.key unavailable'
      })
      return null
    }

    // Mirror the WAV bytes to a local filesystem path so Chatterbox's TTS
    // interface can read them. The SDK's resolveModelPath (verified against
    // node_modules/@qvac/sdk/dist/server/rpc/handlers/load-model/resolve.js:94-133)
    // handles ONLY: pear://, registry://, http(s)://, and bare filesystem
    // paths. There is no hyperblob:// scheme, so passing a hyperblob-URL
    // reference resolves to a non-existent file and TTSInterface at
    // node_modules/@qvac/tts-ggml/tts.js:16 throws
    // "Error: reference audio not found: hyperblob://...". The Hyperblob write
    // stays as the P2P replication surface (other peers pull the reference
    // from the room's corestore); this mirror file is the local-read surface
    // that the tts-ggml addon actually opens.
    let filePath = null
    if (storageDir && typeof storageDir === 'string') {
      try {
        const path = _tryRequire('bare-path', 'path')
        const fs = _tryRequire('bare-fs', 'fs')
        const dir = path.join(storageDir, 'qvac-models')
        try { fs.mkdirSync(dir, { recursive: true }) } catch (err) {
          if (err.code !== 'EEXIST') throw err
        }
        filePath = path.join(dir, 'voice-clone-reference-' + blobCoreKey.slice(0, 16) + '.wav')
        fs.writeFileSync(filePath, bytes)
      } catch (err) {
        log('warn', 'voiceClone: filesystem mirror write failed; TTS may not resolve reference', {
          message: err && err.message
        })
        filePath = null
      }
    } else {
      log('warn', 'voiceClone: no storageDir provided; TTS reference audio will not be resolvable')
    }

    state.referenceRef = {
      blobCoreKey,
      blobIndex,
      sizeBytes: bytes.byteLength,
      filePath
    }
    void corestore // referenced for future replication path; keeps lint quiet
    emit('voiceClone:enrolled', {
      blobCoreKey,
      blobIndex,
      sizeBytes: bytes.byteLength,
      filePath
    })
    return { ...state.referenceRef }
  }

  /**
   * Explicitly install a reference descriptor (e.g. read from Hyperbee at
   * boot). Used when the host restarts and does not need to re-enrol from a
   * mic capture.
   */
  function setReference (ref) {
    if (!ref || typeof ref !== 'object') return false
    const { blobCoreKey, blobIndex, filePath } = ref
    if (typeof blobCoreKey !== 'string' || blobCoreKey.length === 0) return false
    if (!Number.isFinite(blobIndex) || blobIndex < 0) return false
    // filePath is the filesystem mirror of the reference WAV. Optional at the
    // setReference boundary (caller may re-hydrate it before speak()), but
    // required by ensureModel() at speak time — see the NO_REFERENCE_FILE
    // error there. Callers doing a "resume without re-enroll" must restore
    // the mirror from the Hyperblob before setReference, otherwise the first
    // speak() will error out cleanly instead of silently synthesising with
    // an empty reference.
    state.referenceRef = {
      blobCoreKey,
      blobIndex,
      sizeBytes: Number.isFinite(ref.sizeBytes) ? ref.sizeBytes : null,
      filePath: typeof filePath === 'string' && filePath.length > 0 ? filePath : null
    }
    return true
  }

  async function ensureModel (locale) {
    const target = normaliseLocale(locale) || state.defaultLocale
    if (state.modelIdByLocale.has(target)) {
      return state.modelIdByLocale.get(target)
    }
    const sdk = await loadSdk()
    if (!sdk) {
      const msg = 'Chatterbox unavailable in @qvac/sdk'
      state.lastError = msg
      emit('voiceClone:error', { code: 'SDK_UNAVAILABLE', message: msg })
      return null
    }
    if (!state.referenceRef) {
      emit('voiceClone:error', {
        code: 'NO_REFERENCE',
        message: 'enroll must be called before speak'
      })
      return null
    }
    const modelSrc = sdk[CHATTERBOX_MODEL_SRC_KEY] || CHATTERBOX_MODEL_SRC_KEY
    // Resolve the S3Gen companion from the SDK's registry exports the same way
    // we resolve the T3 model. The schema accepts either a whole registry
    // constant OR its `.src` string (dist/schemas/text-to-speech.d.ts:225 ->
    // ZodUnion<[ZodString, ZodObject<{ src: ZodString, ... }>]>). We prefer the
    // full object because it carries expectedSize + sha256Checksum which the
    // SDK uses for integrity checks. Fallback to the plain constant name so
    // older SDK releases that name-lookup internally still resolve it.
    const s3genModelSrc = sdk[CHATTERBOX_S3GEN_SRC_KEY] || CHATTERBOX_S3GEN_SRC_KEY
    // referenceAudioSrc MUST be a scheme the SDK's resolveModelPath can
    // resolve. `hyperblob://` is not registered there (only pear://, registry://,
    // http(s)://, filesystem paths). If enroll() successfully wrote the
    // filesystem mirror alongside the Hyperblob, prefer that path. Fail loudly
    // otherwise so we don't hit the opaque
    // "reference audio not found: hyperblob://..." error at TTSInterface init.
    const refFilePath = state.referenceRef && state.referenceRef.filePath
    if (!refFilePath || typeof refFilePath !== 'string') {
      const msg = 'reference audio filesystem mirror missing — pass storageDir to createVoiceClone'
      state.lastError = msg
      emit('voiceClone:error', { code: 'NO_REFERENCE_FILE', locale: target, message: msg })
      return null
    }
    let modelId
    try {
      emit('voiceClone:loading', { locale: target })
      modelId = await sdk.loadModel({
        modelSrc,
        modelType: 'tts',
        modelConfig: {
          ttsEngine: 'chatterbox',
          language: target,
          // Required by resolveChatterboxConfig; missing → TtsArtifactsRequiredError.
          s3genModelSrc,
          // Bare filesystem path; SDK's resolveModelPath (resolve.js:134-149)
          // treats anything with a `/` as a filesystem path and hands it
          // through unchanged. TTSInterface then opens the WAV directly.
          referenceAudioSrc: refFilePath
        },
        onProgress: (p) => emit('voiceClone:progress', {
          locale: target,
          percentage: p && (p.percentage ?? p.percent ?? null)
        })
      })
    } catch (err) {
      state.lastError = err && err.message
      emit('voiceClone:error', {
        code: err && err.code ? err.code : 'LOAD_FAILED',
        locale: target,
        message: err && err.message
      })
      return null
    }
    if (!modelId) return null
    state.modelIdByLocale.set(target, modelId)
    state.ready = true
    emit('voiceClone:ready', {
      locale: target,
      modelId,
      modelPrefix: CHATTERBOX_MODEL_ID_PREFIX
    })
    return modelId
  }

  /**
   * Synthesise `text` in the enrolled voice for `locale`. Returns
   * `{ samples, sampleRate, locale }` or `null` on any failure.
   */
  async function speak (text, locale) {
    if (!voiceCloneFlagEnabled()) {
      emit('voiceClone:skip', { reason: 'FLAG_OFF' })
      return null
    }
    if (state.destroyed) return null

    const target = normaliseLocale(locale)
    if (!target) {
      emit('voiceClone:skip', {
        reason: 'LOCALE_NOT_SUPPORTED',
        locale: typeof locale === 'string' ? locale : null,
        allowed: Array.from(ALLOWED_CLONE_LOCALES)
      })
      return null
    }

    const clean = sanitizeText(text)
    if (clean.length === 0) {
      emit('voiceClone:skip', { reason: 'EMPTY_TEXT', locale: target })
      return null
    }

    const modelId = await ensureModel(target)
    if (!modelId) return null

    const sdk = state.sdk
    try {
      const result = sdk.textToSpeech({
        modelId,
        inputType: 'text',
        text: clean,
        stream: false,
        sentenceStream: false
      })
      const buffer = await result.buffer
      if (!Array.isArray(buffer) && !(buffer instanceof Int16Array)) {
        emit('voiceClone:error', { code: 'BAD_BUFFER', locale: target })
        return null
      }
      const samples = Array.isArray(buffer) ? buffer : Array.from(buffer)
      if (samples.length === 0) {
        emit('voiceClone:error', { code: 'EMPTY_BUFFER', locale: target })
        return null
      }
      emit('voiceClone:synth', {
        locale: target,
        samples: samples.length,
        sampleRate: CHATTERBOX_SAMPLE_RATE
      })
      return {
        samples,
        sampleRate: CHATTERBOX_SAMPLE_RATE,
        locale: target
      }
    } catch (err) {
      state.lastError = err && err.message
      emit('voiceClone:error', {
        code: 'SYNTH_FAILED', locale: target,
        message: err && err.message
      })
      return null
    }
  }

  /**
   * Streaming parity with announcer.openSpeakStream. Returns
   * `{ chunks, end, destroy }` where `chunks` is an async iterator of
   * `{ buffer, sampleRate, done }` frames. When Chatterbox streaming is not
   * available on the installed SDK (e.g. older builds that only expose the
   * non-stream `buffer` promise) we degrade to `speak()` and emit ONE chunk
   * with the full PCM followed by `{ done: true }`. Callers can drain this
   * exactly like the announcer's session — no branching needed on their side.
   *
   * The tts-open / tts-end events on the goal-pipeline bus are emitted by the
   * pipeline, not here; this seam is intentionally quiet so the pipeline
   * remains the single point of truth for orchestration events.
   *
   * @param {string} text
   * @param {string} locale
   * @returns {Promise<{ chunks: AsyncIterable<{buffer:number[],sampleRate:number,done:boolean}>, end: Function, destroy: Function } | null>}
   */
  async function speakStream (text, locale) {
    if (!voiceCloneFlagEnabled()) {
      emit('voiceClone:skip', { reason: 'FLAG_OFF' })
      return null
    }
    if (state.destroyed) return null
    const target = normaliseLocale(locale)
    if (!target) {
      emit('voiceClone:skip', {
        reason: 'LOCALE_NOT_SUPPORTED',
        locale: typeof locale === 'string' ? locale : null,
        allowed: Array.from(ALLOWED_CLONE_LOCALES)
      })
      return null
    }
    // Preferred path: SDK exposes a `textToSpeechStream` primitive. This is
    // the same shape Curva's announcer uses under the hood. When absent, fall
    // back to the buffer path.
    const sdk = await loadSdk()
    if (!sdk) return null
    const clean = sanitizeText(text)
    if (clean.length === 0) {
      emit('voiceClone:skip', { reason: 'EMPTY_TEXT', locale: target })
      return null
    }
    const modelId = await ensureModel(target)
    if (!modelId) return null

    if (typeof sdk.textToSpeechStream === 'function') {
      try {
        const session = sdk.textToSpeechStream({ modelId })
        if (session && typeof session.write === 'function') {
          try { session.write(clean) } catch { /* noop */ }
          try { if (typeof session.end === 'function') session.end() } catch { /* noop */ }
          const chunks = (async function * () {
            try {
              for await (const evt of session) {
                if (!evt || typeof evt !== 'object') continue
                const buffer = Array.isArray(evt.buffer) ? evt.buffer : []
                yield {
                  buffer,
                  sampleRate: CHATTERBOX_SAMPLE_RATE,
                  done: !!evt.done
                }
                if (evt.done) break
              }
            } catch (err) {
              emit('voiceClone:error', {
                code: 'STREAM_FAILED', locale: target,
                message: err && err.message
              })
            }
          })()
          return {
            chunks,
            end () { try { session.end?.() } catch { /* noop */ } },
            destroy () { try { session.destroy?.() } catch { /* noop */ } }
          }
        }
      } catch (err) {
        emit('voiceClone:error', {
          code: 'STREAM_OPEN_FAILED', locale: target,
          message: err && err.message
        })
        // fall through to buffer degrade path
      }
    }

    // Degrade to non-stream speak(): synthesize the whole buffer and emit one
    // chunk. Preserves the callers' `for await` loop shape.
    const one = await speak(clean, target)
    if (!one) return null
    const chunks = (async function * () {
      yield { buffer: one.samples, sampleRate: one.sampleRate, done: false }
      yield { buffer: [], sampleRate: one.sampleRate, done: true }
    })()
    return {
      chunks,
      end () { /* one-shot; nothing to close */ },
      destroy () { /* noop */ }
    }
  }

  function status () {
    return {
      ready: state.ready,
      enrolled: !!state.referenceRef,
      referenceRef: state.referenceRef ? { ...state.referenceRef } : null,
      loadedLocales: Array.from(state.modelIdByLocale.keys()),
      allowedLocales: Array.from(ALLOWED_CLONE_LOCALES),
      defaultLocale: state.defaultLocale,
      lastError: state.lastError,
      flagEnabled: voiceCloneFlagEnabled()
    }
  }

  async function close () {
    state.destroyed = true
    const sdk = state.sdk
    if (sdk && typeof sdk.unloadModel === 'function') {
      for (const modelId of state.modelIdByLocale.values()) {
        try { await sdk.unloadModel({ modelId }) } catch { /* noop */ }
      }
    }
    state.modelIdByLocale.clear()
    log('info', 'voiceClone closed', {})
  }

  return {
    enroll,
    setReference,
    speak,
    speakStream,
    status,
    close,
    _internal: {
      state,
      sanitizeText,
      normaliseLocale
    }
  }
}

module.exports = {
  createVoiceClone,
  voiceCloneFlagEnabled,
  sanitizeText,
  normaliseLocale,
  ALLOWED_CLONE_LOCALES,
  CHATTERBOX_MODEL_SRC_KEY,
  CHATTERBOX_S3GEN_SRC_KEY,
  CHATTERBOX_MODEL_ID_PREFIX,
  CHATTERBOX_SAMPLE_RATE,
  MAX_REFERENCE_BYTES,
  MAX_TEXT_CHARS
}
