// Curva Wave 3 F2: Chatterbox voice-cloned commentator.
//
// Docs-verification memo ----------------------------------------------------
//
// Ground truth (installed):
//   pear-app/node_modules/@qvac/sdk/dist/schemas/text-to-speech.d.ts:2
//     `TTS_CHATTERBOX_LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl',
//                                  'pl', 'tr', 'sv', 'da', 'fi', 'no', 'el',
//                                  'ms', 'sw', 'ar', 'ko', 'he', 'ru', 'zh',
//                                  'hi']`
//     Indonesian (`id`) is NOT in the Chatterbox language set. We restrict
//     voice cloning to EN/IT and refuse other locales with a documented
//     `LOCALE_NOT_SUPPORTED` skip event.
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

// The Chatterbox subset we support in Curva demos. `es`, `fr`, etc. are
// supported by the engine but Curva's UX targets EN/IT for Wave 3.
const ALLOWED_CLONE_LOCALES = Object.freeze(new Set(['en', 'it']))

const CHATTERBOX_MODEL_SRC_KEY = 'TTS_CHATTERBOX_MULTILINGUAL_Q8_0'
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
 * @param {{
 *   sdk?: object | null,           // preloaded @qvac/sdk namespace
 *   sdkImpl?: object | null,       // test seam
 *   hyperblobs?: object | null,    // Hyperblobs instance used for reference storage
 *   corestore?: object | null,     // corestore (used to open a namespaced core for reference blobs)
 *   log?: (level: string, msg: string, extra?: any) => void,
 *   emit?: (event: string, payload: any) => void,
 *   defaultLocale?: 'en'|'it'
 * }} opts
 */
function createVoiceClone (opts = {}) {
  const {
    sdk: injectedSdk = null,
    sdkImpl = null,
    hyperblobs = null,
    corestore = null,
    log = () => {},
    emit = () => {},
    defaultLocale = 'en'
  } = opts

  const state = {
    destroyed: false,
    ready: false,
    modelIdByLocale: new Map(),
    // { blobCoreKey: hex string, blobIndex: number, mimeType, sizeBytes }
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

    state.referenceRef = {
      blobCoreKey,
      blobIndex,
      sizeBytes: bytes.byteLength
    }
    void corestore // referenced for future replication path; keeps lint quiet
    emit('voiceClone:enrolled', {
      blobCoreKey,
      blobIndex,
      sizeBytes: bytes.byteLength
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
    const { blobCoreKey, blobIndex } = ref
    if (typeof blobCoreKey !== 'string' || blobCoreKey.length === 0) return false
    if (!Number.isFinite(blobIndex) || blobIndex < 0) return false
    state.referenceRef = {
      blobCoreKey,
      blobIndex,
      sizeBytes: Number.isFinite(ref.sizeBytes) ? ref.sizeBytes : null
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
    let modelId
    try {
      emit('voiceClone:loading', { locale: target })
      modelId = await sdk.loadModel({
        modelSrc,
        modelType: 'tts',
        modelConfig: {
          ttsEngine: 'chatterbox',
          language: target,
          referenceAudioSrc: {
            src: 'hyperblob://' + state.referenceRef.blobCoreKey,
            blobCoreKey: state.referenceRef.blobCoreKey,
            blobIndex: state.referenceRef.blobIndex
          }
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
  CHATTERBOX_MODEL_ID_PREFIX,
  CHATTERBOX_SAMPLE_RATE,
  MAX_REFERENCE_BYTES,
  MAX_TEXT_CHARS
}
