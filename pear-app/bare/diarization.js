// Curva Parakeet Sortformer diarized replay (Wave 3, F2).
//
// Docs-verification memo ---------------------------------------------------
//
// Runs a Parakeet streaming transcribeStream session with the Sortformer
// speaker cache enabled and maintains a per-speaker turn table + cumulative
// duration for UI badges ("Andi 12s / Budi 8s / Sari 6s").
//
// Ground truth (installed @qvac/sdk 0.14.0, cited by path + line):
//   - pear-app/node_modules/@qvac/sdk/dist/schemas/transcription-config.d.ts:120-126
//       parakeetStreamingConfig (load-time) exposes:
//         streamingSpkCacheEnable: boolean
//         streamingSpkCacheLen: number    (default seconds of speaker cache)
//         streamingSpkCacheUpdatePeriod: number (ms between updates)
//   - pear-app/node_modules/@qvac/sdk/dist/schemas/transcription.d.ts:137-150
//       parakeetStreamingRunConfigSchema (per-call overrides) exposes the same
//       fields WITHOUT the `streaming` prefix: spkCacheEnable, spkCacheLen,
//       spkCacheUpdatePeriod. We pass BOTH shapes so either load-time-only or
//       per-call SDK builds pick it up.
//   - pear-app/node_modules/@qvac/sdk/dist/schemas/transcription.d.ts:243-259
//       TranscribeStreamEvent = text | segment | vad | endOfTurn.
//       TranscribeStreamConversationSession implements
//         { write(Uint8Array), end(), destroy(), [Symbol.asyncIterator] }.
//     The base TranscribeSegment schema (line 38-44) is
//         { text, startMs, endMs, append, id }.
//     When spkCacheEnable is true, SDK builds that ship Sortformer diarization
//     ATTACH a speaker id to each segment. We defensively look for any of:
//         segment.speakerId | segment.speaker | segment.spkId | segment.speaker_id
//     because the field name is not yet locked into the .d.ts (the schema uses
//     z.core.$strip so extra fields pass through). If none are present, we fall
//     back to the string 'unknown' and still return a valid turn — so the UI
//     always has SOMETHING to render even on older Parakeet builds.
//
// Docs consulted (WebFetch, 2026-07-10):
//   - https://docs.qvac.tether.io/ai-capabilities/transcription/
//     (Sortformer + streaming spk cache sections)
//
// Failure posture: this feature is COMPANION. All async APIs return
// `{ok:boolean, ...}`; startSession/pushAudio/endSession never throw for
// caller-recoverable errors. The `diarize:error` event carries observability.
//
// Storage: this module keeps the per-speaker table in memory. The caller
// provides an optional `store: (turn) => Promise<void>` callback so it can
// persist to Hyperbee sub / Autobase / anywhere else without this module
// taking a dependency. Failure of the store callback is logged but does NOT
// fail pushAudio (never let persistence back-pressure the audio path).
//
// Style: CommonJS + no em-dashes.

const DEFAULT_MODEL_SRC = 'PARAKEET_STREAMING'    // caller may override
const DEFAULT_SAMPLE_RATE = 16_000
const DEFAULT_BYTES_PER_SAMPLE = 4                // f32le
// 5-minute cap per session; a mis-wired renderer cannot exhaust worker memory
// with pushAudio in a tight loop. If the caller needs longer, they can
// endSession()/startSession() again on a new window.
const SESSION_MAX_DURATION_MS = 5 * 60_000
const SESSION_MAX_BYTES =
  DEFAULT_SAMPLE_RATE * DEFAULT_BYTES_PER_SAMPLE * (SESSION_MAX_DURATION_MS / 1000)
// Per-second push rate limit (same shape as voiceCoach.js H1 fix).
const PUSH_MAX_PER_SEC = 64
const PUSH_RATE_WINDOW_MS = 1000
// Sortformer cache defaults; overridable via opts.
const DEFAULT_SPK_CACHE_LEN = 128
const DEFAULT_SPK_CACHE_UPDATE_PERIOD_MS = 500
// Speaker table bounds. If a hostile audio stream trips the Sortformer into
// emitting a fresh speaker id every segment we cap the map so the module
// cannot balloon memory.
const MAX_TRACKED_SPEAKERS = 32
const UNKNOWN_SPEAKER = 'unknown'

/**
 * Normalise a caller-provided PCM chunk. Same rules as voiceCoach.coerceAudio.
 * Returns null when the input is unsupported so the caller can reject with
 * a typed code.
 */
function coerceAudio (chunk) {
  if (chunk == null) return null
  if (chunk instanceof Uint8Array) return chunk
  if (chunk instanceof Int16Array || chunk instanceof Float32Array) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  return null
}

/**
 * Extract a stable speaker id from a segment. Segments may carry the id under
 * any of several field names depending on the SDK build; we look for all of
 * them and coerce to a short printable string.
 */
function extractSpeakerId (segment) {
  if (!segment || typeof segment !== 'object') return UNKNOWN_SPEAKER
  const candidates = [
    segment.speakerId,
    segment.speaker,
    segment.spkId,
    segment.speaker_id,
    segment.spk
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c.slice(0, 32)
    if (typeof c === 'number' && Number.isFinite(c)) return 'spk-' + Math.trunc(c)
  }
  return UNKNOWN_SPEAKER
}

/**
 * Parakeet Sortformer diarized transcribeStream session with a per-speaker
 * turn table. Wrapped in a factory so the audio rate-limit fuse, the
 * five-minute session cap, and the `unknown` speaker fallback all live in
 * one place - callers cannot accidentally omit any of them.
 *
 * @param {{
 *   sdk?: { transcribeStream: Function, loadModel?: Function, unloadModel?: Function } | null,
 *   sttModelSrc?: string | object,
 *   spkCacheLen?: number,
 *   spkCacheUpdatePeriodMs?: number,
 *   log?: (level:string, msg:string, extra?:any) => void,
 *   emit?: (event:string, payload:any) => void,
 *   now?: () => number
 * }} opts
 * @returns {{ startSession: Function, pushAudio: Function, endSession: Function, close: Function, status: Function }}
 */
function createDiarization (opts = {}) {
  const {
    sdk = null,
    sttModelSrc = DEFAULT_MODEL_SRC,
    spkCacheLen = DEFAULT_SPK_CACHE_LEN,
    spkCacheUpdatePeriodMs = DEFAULT_SPK_CACHE_UPDATE_PERIOD_MS,
    log = () => {},
    emit = () => {},
    now = () => Date.now()
  } = opts

  const state = {
    closed: false,
    sessionActive: false,
    sessionId: 0,
    session: null,
    consumePromise: null,
    // bytes seen in the current session (envelope enforcement).
    bytesThisSession: 0,
    // rolling per-second push timestamps for rate limiting.
    pushTimestamps: [],
    // Map<speakerId, {speakerId, totalMs, segmentCount, lastSeenAt, firstSeenAt}>.
    speakerTable: new Map(),
    // Ordered turn list; useful for UI replay. Bounded at 4096 to cap memory.
    turns: [],
    lastError: null,
    // Optional caller-provided persistence callback set via startSession.
    store: null
  }

  const TURN_LOG_MAX = 4096

  function status () {
    return {
      hasSdk: !!(sdk && typeof sdk.transcribeStream === 'function'),
      sessionActive: state.sessionActive,
      sessionId: state.sessionId,
      speakerCount: state.speakerTable.size,
      turnCount: state.turns.length,
      bytesThisSession: state.bytesThisSession,
      lastError: state.lastError,
      closed: state.closed
    }
  }

  /**
   * Open a Parakeet streaming session with Sortformer speaker cache enabled.
   *
   * @param {{
   *   sampleRate?: number,
   *   store?: (turn:object) => Promise<void>,
   *   resetTable?: boolean
   * }} [sessionOpts]
   * @returns {Promise<{ok:boolean, sessionId?:number, code?:string, reason?:string}>}
   */
  async function startSession (sessionOpts = {}) {
    if (state.closed) return { ok: false, code: 'CLOSED', reason: 'diarization closed' }
    if (state.sessionActive) {
      return { ok: false, code: 'SESSION_ACTIVE', reason: 'end current session first' }
    }
    if (!sdk || typeof sdk.transcribeStream !== 'function') {
      const msg = 'sdk.transcribeStream unavailable'
      state.lastError = msg
      emit('diarize:error', { code: 'STT_UNAVAILABLE', message: msg })
      return { ok: false, code: 'STT_UNAVAILABLE', reason: msg }
    }

    const { store = null, resetTable = false } = sessionOpts
    if (resetTable) {
      state.speakerTable.clear()
      state.turns.length = 0
    }
    state.store = typeof store === 'function' ? store : null

    state.sessionId += 1
    const currentSession = state.sessionId
    state.bytesThisSession = 0
    state.pushTimestamps.length = 0

    let session
    try {
      // We pass BOTH the load-time-flavoured `streamingSpkCache*` fields AND
      // the per-call `spkCache*` fields so any SDK build with either shape
      // enables Sortformer diarization. Extras pass through z.core.$strip.
      session = await sdk.transcribeStream({
        modelId: typeof sttModelSrc === 'string' ? sttModelSrc : (sttModelSrc?.name || DEFAULT_MODEL_SRC),
        parakeetStreamingConfig: {
          spkCacheEnable: true,
          spkCacheLen,
          spkCacheUpdatePeriod: spkCacheUpdatePeriodMs,
          // Redundant streaming* names for older SDK builds; harmless extras.
          streamingSpkCacheEnable: true,
          streamingSpkCacheLen: spkCacheLen,
          streamingSpkCacheUpdatePeriod: spkCacheUpdatePeriodMs,
          emitPartials: false
        }
      })
    } catch (err) {
      state.lastError = err?.message || 'transcribeStream failed'
      emit('diarize:error', { code: 'STT_OPEN', message: state.lastError })
      return { ok: false, code: 'STT_OPEN', reason: state.lastError }
    }
    if (!session || typeof session.write !== 'function' || typeof session.end !== 'function') {
      state.lastError = 'transcribeStream returned no session'
      emit('diarize:error', { code: 'STT_OPEN', message: state.lastError })
      return { ok: false, code: 'STT_OPEN', reason: state.lastError }
    }
    state.session = session
    state.sessionActive = true

    // Consumer loop. Runs until the async iterator is exhausted or endSession
    // races us to close(). All errors are logged + emitted, never thrown to
    // the caller (this coroutine lives detached from startSession's callsite).
    state.consumePromise = (async () => {
      try {
        for await (const event of session) {
          if (currentSession !== state.sessionId) break
          if (!event || typeof event !== 'object') continue
          if (event.type === 'segment') {
            handleSegment(event.segment, currentSession)
          } else if (event.type === 'vad') {
            emit('diarize:vad', {
              sessionId: currentSession,
              speaking: !!event.speaking,
              probability: Number(event.probability) || 0
            })
          } else if (event.type === 'endOfTurn') {
            emit('diarize:endOfTurn', {
              sessionId: currentSession,
              source: event.source || null,
              silenceDurationMs: event.silenceDurationMs ?? null
            })
          }
          // 'text' events are partials; Sortformer diarization surfaces via
          // 'segment' so we ignore text-only frames for the per-speaker table.
        }
      } catch (err) {
        state.lastError = err?.message || 'stt iterator error'
        emit('diarize:error', {
          code: 'STT_STREAM',
          sessionId: currentSession,
          message: state.lastError
        })
      }
    })()

    emit('diarize:session-started', {
      sessionId: currentSession,
      spkCacheLen,
      spkCacheUpdatePeriodMs
    })
    return { ok: true, sessionId: currentSession }
  }

  function handleSegment (segment, sessionId) {
    if (!segment || typeof segment !== 'object') return
    const text = typeof segment.text === 'string' ? segment.text : ''
    const startMs = Number.isFinite(segment.startMs) ? Math.max(0, Number(segment.startMs)) : 0
    const endMs = Number.isFinite(segment.endMs) ? Math.max(startMs, Number(segment.endMs)) : startMs
    if (endMs <= startMs && text.length === 0) return

    const speakerId = extractSpeakerId(segment)
    // Cap number of tracked speakers to defend against pathological input.
    if (!state.speakerTable.has(speakerId) && state.speakerTable.size >= MAX_TRACKED_SPEAKERS) {
      log('warn', 'diarize: speaker table full, dropping new speaker', { speakerId })
      emit('diarize:speaker-cap', { sessionId, speakerId })
      return
    }
    const duration = Math.max(0, endMs - startMs)
    const existing = state.speakerTable.get(speakerId)
    const wallNow = now()
    if (existing) {
      existing.totalMs += duration
      existing.segmentCount += 1
      existing.lastSeenAt = wallNow
    } else {
      state.speakerTable.set(speakerId, {
        speakerId,
        totalMs: duration,
        segmentCount: 1,
        firstSeenAt: wallNow,
        lastSeenAt: wallNow
      })
    }

    const turn = {
      speakerId,
      text: text.slice(0, 500),
      startMs,
      endMs,
      wallClockMs: wallNow,
      sessionId
    }

    // Bounded ring: pop oldest when we would exceed cap.
    if (state.turns.length >= TURN_LOG_MAX) state.turns.shift()
    state.turns.push(turn)

    emit('diarize:turn', {
      speakerId: turn.speakerId,
      text: turn.text,
      startMs: turn.startMs,
      endMs: turn.endMs
    })

    // Fire the optional persistence callback but do NOT await it in a way
    // that back-pressures the SDK iterator. We schedule + swallow errors.
    if (state.store) {
      Promise.resolve()
        .then(() => state.store(turn))
        .catch((err) => log('warn', 'diarize store threw', { message: err && err.message }))
    }
  }

  /**
   * Push a PCM chunk into the active session. Returns a status object rather
   * than throwing so the caller can drive this from an IPC boundary.
   *
   * @param {Uint8Array | Buffer | ArrayBuffer | Int16Array | Float32Array} chunk
   * @returns {Promise<{ok:boolean, code?:string, bytes?:number, message?:string}>}
   */
  async function pushAudio (chunk) {
    if (state.closed) return { ok: false, code: 'CLOSED' }
    if (!state.sessionActive || !state.session) return { ok: false, code: 'NO_SESSION' }

    // Rate limit: rolling window trimmed to PUSH_RATE_WINDOW_MS.
    const wallNow = Date.now()
    const cutoff = wallNow - PUSH_RATE_WINDOW_MS
    state.pushTimestamps = state.pushTimestamps.filter((t) => t > cutoff)
    if (state.pushTimestamps.length >= PUSH_MAX_PER_SEC) {
      emit('diarize:error', {
        code: 'AUDIO_RATE_LIMIT',
        message: 'pushAudio rate exceeded ' + PUSH_MAX_PER_SEC + '/s'
      })
      return { ok: false, code: 'AUDIO_RATE_LIMIT' }
    }

    const bytes = coerceAudio(chunk)
    if (!bytes) {
      emit('diarize:error', { code: 'BAD_AUDIO', message: 'unsupported audio chunk type' })
      return { ok: false, code: 'BAD_AUDIO' }
    }
    if (state.bytesThisSession + bytes.byteLength > SESSION_MAX_BYTES) {
      emit('diarize:audio-cap', {
        bytesSoFar: state.bytesThisSession,
        cap: SESSION_MAX_BYTES
      })
      // Trip the fuse by ending the session gracefully; caller may start a
      // new one on a fresh window.
      try { await endSession({ reason: 'AUDIO_CAP' }) } catch { /* noop */ }
      return { ok: false, code: 'AUDIO_CAP' }
    }

    state.bytesThisSession += bytes.byteLength
    state.pushTimestamps.push(wallNow)

    try {
      await state.session.write(bytes)
    } catch (err) {
      state.lastError = err?.message || 'session.write failed'
      emit('diarize:error', { code: 'STT_WRITE', message: state.lastError })
      return { ok: false, code: 'STT_WRITE', message: state.lastError }
    }
    return { ok: true, bytes: bytes.byteLength }
  }

  /**
   * Gracefully close the current session. Idempotent.
   *
   * @param {{ reason?: string }} [endOpts]
   * @returns {Promise<{ok:boolean, code?:string}>}
   */
  async function endSession (endOpts = {}) {
    if (!state.sessionActive) return { ok: false, code: 'NO_SESSION' }
    const currentSession = state.sessionId
    state.sessionActive = false
    const session = state.session
    state.session = null
    if (session && typeof session.end === 'function') {
      try { await session.end() } catch (err) {
        log('warn', 'diarize: session.end threw', { message: err && err.message })
      }
    }
    // Drain the consumer so a late segment is not lost between end() and the
    // iterator finishing. Failure is non-fatal.
    if (state.consumePromise) {
      try { await state.consumePromise } catch { /* handled inside */ }
      state.consumePromise = null
    }
    emit('diarize:session-ended', {
      sessionId: currentSession,
      reason: typeof endOpts.reason === 'string' ? endOpts.reason : 'USER'
    })
    return { ok: true, code: 'ENDED' }
  }

  /**
   * Snapshot the per-speaker cumulative table. Sorted by totalMs descending
   * for stable UI rendering.
   *
   * @returns {Array<{speakerId, totalMs, segmentCount, lastSeenAt, firstSeenAt}>}
   */
  function getSpeakerTable () {
    const rows = []
    for (const row of state.speakerTable.values()) {
      rows.push({
        speakerId: row.speakerId,
        totalMs: row.totalMs,
        segmentCount: row.segmentCount,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt
      })
    }
    rows.sort((a, b) => b.totalMs - a.totalMs)
    return rows
  }

  /**
   * Snapshot the ordered turn list. Callers typically render this into a
   * scrollable timeline. Copied to avoid mutation by caller.
   */
  function getTurns () {
    return state.turns.slice()
  }

  async function close () {
    if (state.closed) return
    state.closed = true
    if (state.sessionActive) {
      try { await endSession({ reason: 'CLOSE' }) } catch { /* noop */ }
    }
    // Best-effort unload if we own the model handle.
    if (sdk && typeof sdk.unloadModel === 'function' && typeof sttModelSrc === 'string') {
      try { await sdk.unloadModel({ modelId: sttModelSrc }) } catch { /* noop */ }
    }
  }

  return {
    startSession,
    pushAudio,
    endSession,
    getSpeakerTable,
    getTurns,
    close,
    status,
    _internal: {
      extractSpeakerId,
      coerceAudio,
      state
    }
  }
}

module.exports = {
  createDiarization,
  extractSpeakerId,
  coerceAudio,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_BYTES_PER_SAMPLE,
  SESSION_MAX_BYTES,
  SESSION_MAX_DURATION_MS,
  PUSH_MAX_PER_SEC,
  MAX_TRACKED_SPEAKERS,
  UNKNOWN_SPEAKER
}
