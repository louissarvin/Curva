// Curva semantic clip search via embed() (Wave 3, F3).
//
// Docs-verification memo ---------------------------------------------------
//
// Turns free-text queries ("that Ronaldo header") into ranked clip hits by
// embedding both the indexed documents (VLM captions / clip metadata) and the
// query, then computing cosine similarity against an in-memory vector map.
//
// Ground truth (installed @qvac/sdk 0.14.0, cited by path + line):
//   - pear-app/node_modules/@qvac/sdk/dist/client/api/embed.d.ts:13-40
//       embed({modelId, text}) with two overloads:
//         text: string    -> Promise<{ embedding: number[], stats? }>
//         text: string[]  -> Promise<{ embedding: number[][], stats? }>
//     The returned promise carries a `requestId` string on the object; we
//     never introspect it here.
//
// Docs consulted (WebFetch, 2026-07-10):
//   - https://docs.qvac.tether.io/ai-capabilities/text-embeddings/
//
// Persistence: this module is STATELESS across re-init. The caller is
// responsible for external persistence (Hyperbee sub-db, Autobase, JSON
// snapshot on close). We provide `snapshot()` / `restore()` helpers so the
// caller can round-trip the internal Map without touching private state.
//
// LRU eviction: bounded at 1024 entries by default. On overflow the
// least-recently-touched entry is evicted. index() and search() both count as
// touches. This is a soft cap: callers who need a larger index can raise the
// cap at construction time, but should be aware that O(N) cosine over each
// query grows linearly with the index size.
//
// Failure posture: never throws for caller-recoverable errors. index() and
// search() return typed error objects `{ok:false, code, reason}` so callers
// can wire this into an IPC boundary.
//
// Deterministic ordering: results with equal cosine scores are broken by
// insertion order (via the Map.entries iteration + a stable sort), so tests
// can assert repeatable rankings.
//
// Style: CommonJS + no em-dashes.

const DEFAULT_MODEL_SRC = 'EMBEDDINGGEMMA_300M_Q4_0'
const DEFAULT_MAX_ENTRIES = 1024
const DEFAULT_TOP_K = 5
const MAX_TOP_K = 50
const MAX_TEXT_CHARS = 4096          // hard cap per index() call
const MAX_QUERY_CHARS = 1024

/**
 * Cosine similarity of two same-length numeric vectors. Returns 0 when a
 * vector is zero-norm to avoid NaN. This is a hot path called once per
 * indexed entry per query, so it stays inline and branch-light.
 */
function cosine (a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const av = a[i]
    const bv = b[i]
    if (typeof av !== 'number' || typeof bv !== 'number') return 0
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Sanitize + length-cap the caller-supplied text before embedding.
 * Not adversarial - embeddings are not a prompt-injection surface - but we
 * still strip control chars so a rogue caller cannot pollute logs.
 */
function sanitizeText (raw, maxLen) {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, maxLen))
}

/**
 * @param {{
 *   sdk?: { embed: Function, loadModel?: Function, unloadModel?: Function } | null,
 *   sdkImpl?: (() => Promise<any>) | null,
 *   embedModelSrc?: string,
 *   maxEntries?: number,
 *   log?: (level:string, msg:string, extra?:any) => void,
 *   emit?: (event:string, payload:any) => void,
 *   now?: () => number
 * }} opts
 */
function createSemanticSearch (opts = {}) {
  const {
    sdk: injectedSdk = null,
    sdkImpl = null,
    embedModelSrc = DEFAULT_MODEL_SRC,
    maxEntries = DEFAULT_MAX_ENTRIES,
    log = () => {},
    emit = () => {},
    now = () => Date.now()
  } = opts

  const state = {
    closed: false,
    sdk: injectedSdk,
    modelId: null,
    loading: null,
    // Insertion-ordered map: id -> { id, text, vec, addedAt, touchedAt, order }.
    // Iteration order equals insertion order in ES2015 Maps, which we exploit
    // for deterministic tie-breaking in search().
    entries: new Map(),
    orderCounter: 0,
    lastError: null,
    // Access recency for LRU eviction. Larger touch value = more recent.
    touchCounter: 0
  }

  const cap = Math.max(1, Math.min(1 << 20, Number(maxEntries) || DEFAULT_MAX_ENTRIES))

  function status () {
    return {
      ready: !!state.modelId,
      loading: !!state.loading,
      size: state.entries.size,
      cap,
      modelSrc: embedModelSrc,
      lastError: state.lastError,
      closed: state.closed
    }
  }

  async function resolveSdk () {
    if (state.sdk) return state.sdk
    if (typeof sdkImpl === 'function') {
      state.sdk = await sdkImpl()
      return state.sdk
    }
    try {
      const mod = await import('@qvac/sdk').catch(() => null)
      state.sdk = mod || null
    } catch { state.sdk = null }
    return state.sdk
  }

  async function ensureReady () {
    if (state.closed) return null
    if (state.modelId) return state.modelId
    if (state.loading) return state.loading
    state.loading = (async () => {
      const sdk = await resolveSdk()
      if (!sdk || typeof sdk.embed !== 'function' || typeof sdk.loadModel !== 'function') {
        state.lastError = 'embed API unavailable in @qvac/sdk'
        emit('semsearch:error', { code: 'EMBED_UNAVAILABLE', message: state.lastError })
        return null
      }
      try {
        const resolved = (typeof embedModelSrc === 'string' && sdk[embedModelSrc] !== undefined)
          ? sdk[embedModelSrc]
          : embedModelSrc
        emit('semsearch:loading', { modelSrc: descriptorName(embedModelSrc) })
        const modelId = await sdk.loadModel({
          modelSrc: resolved,
          modelType: 'embedding',
          onProgress: (p) => emit('semsearch:progress', {
            percentage: p?.percentage ?? p?.percent ?? null,
            downloaded: p?.downloaded ?? null,
            total: p?.total ?? null
          })
        })
        if (typeof modelId !== 'string' || modelId.length === 0) {
          state.lastError = 'loadModel returned no modelId'
          emit('semsearch:error', { code: 'LOAD_FAILED', message: state.lastError })
          return null
        }
        state.modelId = modelId
        emit('semsearch:ready', { modelId })
        return modelId
      } catch (err) {
        state.lastError = err?.message || 'load failed'
        emit('semsearch:error', { code: 'LOAD_FAILED', message: state.lastError })
        return null
      } finally {
        state.loading = null
      }
    })()
    return state.loading
  }

  /**
   * Evict the least-recently-touched entry to make room. Iteration over Map
   * preserves insertion order which we DO NOT want for LRU, so we track a
   * per-entry `touchedAt` counter and scan for the min. Because the scan is
   * bounded by `cap` (default 1024), the O(N) cost per eviction is tiny and
   * we skip the complexity of an intrusive linked list.
   */
  function evictLru () {
    if (state.entries.size === 0) return null
    let victimId = null
    let victimTouch = Infinity
    for (const [id, row] of state.entries) {
      if (row.touchedAt < victimTouch) {
        victimTouch = row.touchedAt
        victimId = id
      }
    }
    if (victimId !== null) {
      state.entries.delete(victimId)
      emit('semsearch:evicted', { id: victimId })
    }
    return victimId
  }

  /**
   * Index one document. Overwrites any prior entry with the same id.
   *
   * @param {string} id
   * @param {string} text
   * @returns {Promise<{ok:boolean, code?:string, reason?:string, id?:string, dims?:number}>}
   */
  async function index (id, text) {
    if (state.closed) return { ok: false, code: 'CLOSED' }
    if (typeof id !== 'string' || id.length === 0) return { ok: false, code: 'BAD_ID' }
    if (id.length > 128) return { ok: false, code: 'ID_TOO_LONG' }
    const clean = sanitizeText(text, MAX_TEXT_CHARS)
    if (clean.length === 0) return { ok: false, code: 'EMPTY_TEXT' }

    const modelId = await ensureReady()
    if (!modelId) return { ok: false, code: 'NOT_READY', reason: state.lastError }

    let vec
    try {
      const res = await state.sdk.embed({ modelId, text: clean })
      vec = res && Array.isArray(res.embedding) ? res.embedding : null
    } catch (err) {
      emit('semsearch:error', { code: 'EMBED_FAILED', message: err && err.message })
      return { ok: false, code: 'EMBED_FAILED', reason: err && err.message }
    }
    if (!Array.isArray(vec) || vec.length === 0) {
      return { ok: false, code: 'EMBED_EMPTY', reason: 'embed returned no vector' }
    }

    // LRU: if over cap AFTER insertion would occur, evict first. We evict
    // BEFORE insert so replacing an existing id never triggers eviction of
    // that same id (avoids race with `entries.set` overwriting a stale slot).
    if (!state.entries.has(id) && state.entries.size >= cap) {
      evictLru()
    }
    state.touchCounter += 1
    const nowMs = now()
    state.entries.set(id, {
      id,
      text: clean.slice(0, 240),
      vec,
      addedAt: nowMs,
      touchedAt: state.touchCounter,
      order: ++state.orderCounter
    })
    emit('semsearch:indexed', { id, dims: vec.length, size: state.entries.size })
    return { ok: true, id, dims: vec.length }
  }

  /**
   * Cosine-rank indexed entries against the query.
   *
   * @param {string} query
   * @param {{ topK?: number }} [searchOpts]
   * @returns {Promise<Array<{id, score, text}>>}
   */
  async function search (query, searchOpts = {}) {
    if (state.closed) return []
    if (typeof query !== 'string') return []
    const cleanQuery = sanitizeText(query, MAX_QUERY_CHARS)
    if (cleanQuery.length === 0) return []
    if (state.entries.size === 0) return []

    const modelId = await ensureReady()
    if (!modelId) return []

    let qvec
    try {
      const res = await state.sdk.embed({ modelId, text: cleanQuery })
      qvec = res && Array.isArray(res.embedding) ? res.embedding : null
    } catch (err) {
      emit('semsearch:error', { code: 'EMBED_FAILED', message: err && err.message })
      return []
    }
    if (!Array.isArray(qvec) || qvec.length === 0) return []

    const topK = Math.max(1, Math.min(MAX_TOP_K, Number(searchOpts.topK) || DEFAULT_TOP_K))

    // Score all entries. Deterministic tie-break via insertion `order`.
    const scored = []
    for (const row of state.entries.values()) {
      const score = cosine(qvec, row.vec)
      scored.push({ id: row.id, score, text: row.text, order: row.order })
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.order - b.order
    })
    const out = scored.slice(0, topK).map(({ id, score, text }) => ({ id, score, text }))

    // Touch the returned rows so relevant entries survive the LRU pressure.
    state.touchCounter += 1
    for (const hit of out) {
      const row = state.entries.get(hit.id)
      if (row) row.touchedAt = state.touchCounter
    }
    emit('semsearch:searched', { count: out.length, top: out[0]?.score ?? null })
    return out
  }

  /**
   * Remove an entry by id. Idempotent.
   */
  function remove (id) {
    if (state.closed) return { ok: false, code: 'CLOSED' }
    if (typeof id !== 'string') return { ok: false, code: 'BAD_ID' }
    const had = state.entries.delete(id)
    if (had) emit('semsearch:removed', { id })
    return { ok: true, removed: had }
  }

  /**
   * Snapshot the current index for external persistence. Returns a shallow
   * copy so mutation by the caller does not corrupt state.
   */
  function snapshot () {
    const rows = []
    for (const row of state.entries.values()) {
      rows.push({
        id: row.id,
        text: row.text,
        vec: row.vec.slice(),
        addedAt: row.addedAt,
        order: row.order
      })
    }
    return { modelSrc: embedModelSrc, size: rows.length, entries: rows }
  }

  /**
   * Rehydrate from a snapshot. Overwrites any current entries. Does NOT call
   * embed(); vectors are trusted to have been produced by the same model.
   */
  function restore (snap) {
    if (state.closed) return { ok: false, code: 'CLOSED' }
    if (!snap || !Array.isArray(snap.entries)) return { ok: false, code: 'BAD_SNAPSHOT' }
    state.entries.clear()
    state.orderCounter = 0
    state.touchCounter = 0
    for (const row of snap.entries) {
      if (!row || typeof row.id !== 'string' || !Array.isArray(row.vec)) continue
      state.touchCounter += 1
      state.entries.set(row.id, {
        id: row.id,
        text: typeof row.text === 'string' ? row.text : '',
        vec: row.vec.slice(),
        addedAt: Number(row.addedAt) || now(),
        touchedAt: state.touchCounter,
        order: ++state.orderCounter
      })
      if (state.entries.size >= cap) break
    }
    return { ok: true, size: state.entries.size }
  }

  async function close () {
    if (state.closed) return
    state.closed = true
    state.entries.clear()
    if (state.modelId && state.sdk && typeof state.sdk.unloadModel === 'function') {
      try { await state.sdk.unloadModel({ modelId: state.modelId }) } catch { /* noop */ }
    }
    state.modelId = null
  }

  return {
    index,
    search,
    remove,
    snapshot,
    restore,
    close,
    status,
    _internal: {
      cosine,
      sanitizeText,
      state
    }
  }
}

function descriptorName (m) {
  if (!m) return null
  if (typeof m === 'string') return m
  if (typeof m === 'object' && typeof m.name === 'string') return m.name
  return null
}

module.exports = {
  createSemanticSearch,
  cosine,
  sanitizeText,
  DEFAULT_MODEL_SRC,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TOP_K,
  MAX_TOP_K,
  MAX_TEXT_CHARS,
  MAX_QUERY_CHARS
}
