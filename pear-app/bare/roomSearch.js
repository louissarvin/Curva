// Curva room-scoped semantic chat search (F6).
//
// Docs-verification memo ---------------------------------------------------
//
// Source of truth is the installed @qvac/sdk 0.14.0 at
//   pear-app/node_modules/@qvac/sdk/dist/client/api/rag.d.ts (verified head)
//     ragChunk({documents, chunkOpts})     -> Promise<RagDoc[]>
//     ragIngest({modelId, workspace, documents, chunk?, chunkOpts?})
//                                         -> Promise<{processed, droppedIndices}>
//     ragSearch({modelId, workspace, query, topK?, n?})
//                                         -> Promise<Array<{id, content, score, ...}>>
//     ragCloseWorkspace({workspace, deleteOnClose?}) -> Promise<void>
// Docs consulted (WebFetch, 2026-07-10):
//   https://docs.qvac.tether.io/ai-capabilities/rag/
//
// Purpose: peer-local RAG workspace scoped to a single room's own chat log.
// A late-joining or scrolling viewer can semantic-search all applied messages
// ("what did jamal say about penalties") and get sub-200ms hits without
// touching the network. All embed/search work runs on-device via QVAC.
//
// Workspace naming: `curva-room-search-<sha256(roomSlug).slice(0,16)>`. The
// hash prefix caps at 16 hex chars (64 bits) which is enough to make cross-
// room collisions negligible while keeping the workspace path bounded. We
// deliberately do NOT reuse `curva/room/<slug>/chat` (the bare/rag.js
// workspace naming convention) because bare/rag.js is a shared surface
// (roomBot + commentator both write into it) and we do not want their
// glossary ingests to pollute chat semantic search.
//
// Persistence: at room close we call `sdk.ragCloseWorkspace({workspace})`
// WITHOUT deleteOnClose so the vector DB persists across app boots for the
// same room. `reindexAll` is idempotent (dedupe by document id) so replays
// after a boot do not duplicate chunks.
//
// Prompt-injection defense: every ingested text is NFKC-normalized and
// C0/C1 control chars are stripped before it lands in the vector DB. The
// search query is user input from the renderer, so it gets the same
// treatment.
//
// Debounce: multiple ingest calls arriving within DEBOUNCE_REINDEX_MS collapse
// to a single reindex-all pass. Prevents thrash during a chat storm.
//
// Failure posture: when the SDK is absent or fails, search() returns [] and
// ingestMessage() is a no-op. The chat UI keeps rendering; only the semantic
// search bar goes cold.
//
// Style: CommonJS + no em-dashes.

const crypto = require('crypto')

const DEFAULT_EMBED_MODEL_SRC = 'EMBEDDINGGEMMA_300M_Q4_0'
const DEFAULT_CHUNK_SIZE = 200
const DEFAULT_CHUNK_OVERLAP = 20
const DEFAULT_TOP_K = 10
const MAX_TOP_K = 25
const MAX_QUERY_CHARS = 500
const MAX_TEXT_CHARS = 2000
const HISTORY_REINDEX_LIMIT = 500
const DEBOUNCE_REINDEX_MS = 15_000

function flagEnabled () {
  try {
    const raw = (typeof process !== 'undefined' && process.env &&
      process.env.CURVA_ROOM_SEARCH_ENABLED) || ''
    if (raw === '') return true // default ON
    const s = String(raw).toLowerCase()
    return s === '1' || s === 'true' || s === 'yes' || s === 'on'
  } catch { return true }
}

function sha256Hex (s) {
  return crypto.createHash('sha256').update(String(s || 'default'), 'utf8').digest('hex')
}

function workspaceForRoom (roomSlug) {
  const digest = sha256Hex(roomSlug || 'default').slice(0, 16)
  return 'curva-room-search-' + digest
}

/**
 * Sanitize free-form text before ingest or search.
 *
 * - NFKC normalization collapses width/compat forms so a peer cannot ingest
 *   the same word twice by using half-width variants.
 * - Strip C0 (0x00-0x1F excluding \n\r\t which we replace with spaces),
 *   DEL (0x7F), and C1 (0x80-0x9F). These carry no semantic value in chat
 *   text and are a classic prompt-injection vector (e.g. RTL override).
 * - Collapse whitespace + trim + cap length.
 *
 * Returns '' for anything invalid so callers can bail early on empty text.
 */
function sanitizeText (raw, { maxLen = MAX_TEXT_CHARS } = {}) {
  if (typeof raw !== 'string') return ''
  let s
  try { s = raw.normalize('NFKC') } catch { s = raw }
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (code === 0x0A || code === 0x0D || code === 0x09) { out += ' '; continue }
    if (code < 0x20) continue
    if (code === 0x7F) continue
    if (code >= 0x80 && code <= 0x9F) continue
    if (code === 0xFEFF) continue
    out += ch
  }
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length > maxLen) out = out.slice(0, maxLen)
  return out
}

/**
 * @param {{
 *   sdk?: object,                   // installed @qvac/sdk instance (or test fake)
 *   chat?: { history?: (opts?:object)=>Promise<Array>, onMessage?: (cb:Function)=>Function },
 *   roomSlug?: string,
 *   embedModelSrc?: string,
 *   emit?: (event:string, payload:any) => void,
 *   log?: (level:string, msg:string, extra?:any) => void,
 *   now?: () => number             // test seam
 * }} opts
 */
function createRoomSearch (opts = {}) {
  const {
    sdk = null,
    chat = null,
    roomSlug = 'default',
    embedModelSrc = DEFAULT_EMBED_MODEL_SRC,
    emit = () => {},
    log = () => {},
    now = () => Date.now()
  } = opts

  const enabled = flagEnabled()
  const workspace = workspaceForRoom(roomSlug)

  const state = {
    enabled,
    ready: false,
    closed: false,
    modelId: null,
    sdk,
    workspace,
    roomSlug,
    lastReindexAt: 0,
    reindexInFlight: null,
    reindexTimer: null,
    ingestedIds: new Set(),   // dedupe by ingest doc id across reindex + drip
    stats: { ingested: 0, searches: 0, reindexes: 0, errors: 0 },
    lastError: null
  }

  function status () {
    return {
      enabled: !!state.enabled,
      ready: !!state.ready,
      closed: !!state.closed,
      workspace: state.workspace,
      roomSlug: state.roomSlug,
      modelId: state.modelId,
      lastReindexAt: state.lastReindexAt,
      stats: { ...state.stats },
      lastError: state.lastError,
      hasSdk: !!state.sdk
    }
  }

  async function resolveSdk () {
    if (state.sdk) return state.sdk
    try {
      const mod = await import('@qvac/sdk').catch(() => null)
      state.sdk = mod || null
    } catch { state.sdk = null }
    return state.sdk
  }

  async function ensureReady () {
    if (!state.enabled || state.closed) return false
    if (state.ready && state.modelId) return true
    const sdk = await resolveSdk()
    if (!sdk || typeof sdk.loadModel !== 'function' ||
        typeof sdk.ragIngest !== 'function' ||
        typeof sdk.ragSearch !== 'function') {
      state.lastError = 'ROOM_SEARCH_SDK_UNAVAILABLE'
      return false
    }
    try {
      const resolved = (typeof embedModelSrc === 'string' && sdk[embedModelSrc] !== undefined)
        ? sdk[embedModelSrc]
        : embedModelSrc
      // NOTE (2026-07-11 debug): SDK rejects the pair `{modelSrc: 'llamacpp-
      // embedding', modelType: 'embedding'}` with:
      //   modelSrc describes "llamacpp-embedding", but modelType resolves to
      //   "embedding". Omit modelType to infer it automatically, or pass a
      //   matching modelType.
      // Fix: omit modelType and let the SDK infer from modelSrc. Same shape
      // used by bare/rag.js which loads embeddings the same way.
      const modelId = await sdk.loadModel({
        modelSrc: resolved
      })
      if (typeof modelId !== 'string' || modelId.length === 0) {
        state.lastError = 'LOAD_NO_MODEL_ID'
        return false
      }
      state.modelId = modelId
      state.ready = true
      state.lastError = null
      emit('room-search:ready', { workspace: state.workspace, modelId })
      return true
    } catch (err) {
      state.lastError = (err && err.message) || 'LOAD_FAILED'
      state.stats.errors += 1
      log('warn', 'roomSearch load failed', { message: state.lastError })
      return false
    }
  }

  /**
   * Deterministic ingest id per (msgId, chunkIdx). Rebase-safe: replaying the
   * same message yields the same ids, so the vector DB stays de-duplicated.
   */
  function ingestIdFor (msgId, chunkIdx) {
    const safeId = String(msgId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'anon'
    return 'msg-' + safeId + '-' + (chunkIdx | 0)
  }

  /**
   * Ingest a single message. Called by chat.js's message-applied hook.
   * Returns {ok, ingested, reason}.
   *
   * Best-effort: never throws, always resolves with a shape the caller can
   * observe. Silently rate-limits reindex-all bursts.
   */
  async function ingestMessage ({ id, author, text, at } = {}) {
    if (!state.enabled) return { ok: false, reason: 'DISABLED' }
    if (state.closed) return { ok: false, reason: 'CLOSED' }
    const clean = sanitizeText(text)
    if (clean.length === 0) return { ok: false, reason: 'EMPTY_TEXT' }
    const msgId = String(id || '').slice(0, 128)
    if (msgId.length === 0) return { ok: false, reason: 'EMPTY_ID' }

    const ready = await ensureReady()
    if (!ready) return { ok: false, reason: 'NOT_READY' }

    const sdk = state.sdk
    // Simple word-boundary chunker. ragIngest also chunks internally, but we
    // want deterministic per-chunk ids so reingest is idempotent. Chunk size
    // + overlap match the module defaults.
    const chunks = simpleChunk(clean, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP)
    if (chunks.length === 0) return { ok: false, reason: 'EMPTY_CHUNKS' }
    const documents = []
    const newIds = []
    for (let i = 0; i < chunks.length; i++) {
      const docId = ingestIdFor(msgId, i)
      if (state.ingestedIds.has(docId)) continue
      documents.push(chunks[i])
      newIds.push(docId)
    }
    if (documents.length === 0) return { ok: true, ingested: 0, reason: 'ALREADY_INGESTED' }

    try {
      // We pass chunk:false because we already chunked. Some SDK builds may
      // ignore this and re-chunk internally; that is fine.
      const res = await sdk.ragIngest({
        modelId: state.modelId,
        workspace: state.workspace,
        documents,
        chunk: false,
        chunkOpts: undefined
      })
      for (const id of newIds) state.ingestedIds.add(id)
      state.stats.ingested += newIds.length
      emit('room-search:ingested', {
        workspace: state.workspace,
        msgId,
        chunks: newIds.length
      })
      // Store metadata keyed by the SDK-assigned document id. ragSearch
      // returns rows whose `id` matches these values, so keying by them is
      // what lets us join search hits back to the original message. Fall
      // back to our internal chunk id when the SDK's processed row does not
      // expose an id (older builds).
      const processed = Array.isArray(res?.processed) ? res.processed : []
      const meta = {
        msgId,
        author: typeof author === 'string' ? author.slice(0, 128) : null,
        at: typeof at === 'number' && Number.isFinite(at) ? at : null
      }
      for (let i = 0; i < documents.length; i++) {
        const sdkRow = processed[i]
        const sdkId = sdkRow && typeof sdkRow.id === 'string' ? sdkRow.id : null
        const internalId = newIds[i]
        // Key metadata under BOTH ids so search that returns either the SDK
        // id OR our internal id (e.g. saveEmbeddings-based builds) can still
        // resolve attribution.
        docMeta.set(internalId, { ...meta, chunkIdx: i })
        docText.set(internalId, documents[i])
        if (sdkId) {
          docMeta.set(sdkId, { ...meta, chunkIdx: i })
          docText.set(sdkId, documents[i])
        }
      }
      return { ok: true, ingested: newIds.length }
    } catch (err) {
      state.lastError = (err && err.message) || 'INGEST_FAILED'
      state.stats.errors += 1
      log('warn', 'roomSearch ingest failed', { message: state.lastError })
      return { ok: false, reason: 'INGEST_FAILED' }
    }
  }

  // Per-chunk metadata + raw text lookup. Persisted for the lifetime of the
  // process only; on next boot reindexAll() from chat history repopulates.
  const docMeta = new Map()
  const docText = new Map()

  /**
   * Reindex all history via chat.history({from:0, limit:HISTORY_REINDEX_LIMIT}).
   * Debounced: a burst of ingestMessage calls collapses to a single call.
   * Returns {ok, processed, skipped}.
   */
  async function reindexAll () {
    if (!state.enabled) return { ok: false, reason: 'DISABLED' }
    if (state.closed) return { ok: false, reason: 'CLOSED' }
    if (state.reindexInFlight) return state.reindexInFlight
    const p = (async () => {
      const ready = await ensureReady()
      if (!ready) return { ok: false, reason: 'NOT_READY' }
      let rows = []
      if (chat && typeof chat.history === 'function') {
        try {
          rows = await chat.history({ from: 0, limit: HISTORY_REINDEX_LIMIT }) || []
        } catch (err) {
          state.stats.errors += 1
          state.lastError = (err && err.message) || 'HISTORY_FAILED'
          return { ok: false, reason: 'HISTORY_FAILED' }
        }
      }
      let processed = 0
      let skipped = 0
      for (const row of rows) {
        if (!row || typeof row !== 'object') { skipped += 1; continue }
        // Only reindex user-authored chat messages. Skip system:* rows to
        // keep the vector DB scoped to conversational content.
        if (row.type && row.type !== 'msg') { skipped += 1; continue }
        const text = typeof row.text === 'string' ? row.text : ''
        if (text.length === 0) { skipped += 1; continue }
        const msgId = row.wall_clock_ms
          ? String(row.wall_clock_ms) + '-' + (row.by_peer || '').slice(0, 8)
          : (row.by_peer || 'anon').slice(0, 8) + '-' + Math.floor(Math.random() * 1e6)
        const res = await ingestMessage({
          id: msgId,
          author: row.by_peer || null,
          text,
          at: row.wall_clock_ms || null
        })
        if (res && res.ok) processed += (res.ingested || 0)
        else skipped += 1
      }
      state.lastReindexAt = now()
      state.stats.reindexes += 1
      emit('room-search:reindexed', {
        workspace: state.workspace,
        processed,
        skipped,
        total: rows.length
      })
      return { ok: true, processed, skipped, total: rows.length }
    })()
    state.reindexInFlight = p
    try { return await p } finally { state.reindexInFlight = null }
  }

  /**
   * Debounced entry point used by the burst-suppression paths (subscribers).
   * Semantics: schedule a reindex to fire at t + DEBOUNCE_REINDEX_MS, but only
   * if one has not run within DEBOUNCE_REINDEX_MS. This ensures a chat storm
   * translates to at most one reindex per debounce window.
   */
  function scheduleDebouncedReindex () {
    if (!state.enabled || state.closed) return
    if (state.reindexTimer) return
    const elapsed = now() - state.lastReindexAt
    const delay = Math.max(0, DEBOUNCE_REINDEX_MS - elapsed)
    const timer = setTimeout(() => {
      state.reindexTimer = null
      reindexAll().catch((err) => {
        log('warn', 'roomSearch debounced reindex threw', { message: err && err.message })
      })
    }, delay)
    state.reindexTimer = timer
    try { timer.unref && timer.unref() } catch { /* noop */ }
  }

  /**
   * Semantic search. Returns [{msgId, author, at, snippet, score}] sorted by
   * score descending. Sanitizes the query the same way ingest sanitizes text.
   */
  async function search ({ query, k = DEFAULT_TOP_K } = {}) {
    if (!state.enabled) return []
    if (state.closed) return []
    const cleanQuery = sanitizeText(query, { maxLen: MAX_QUERY_CHARS })
    if (cleanQuery.length === 0) return []
    const topK = Math.max(1, Math.min(MAX_TOP_K, Number(k) || DEFAULT_TOP_K))
    const ready = await ensureReady()
    if (!ready) return []
    let rows
    try {
      rows = await state.sdk.ragSearch({
        modelId: state.modelId,
        workspace: state.workspace,
        query: cleanQuery,
        topK
      })
    } catch (err) {
      state.stats.errors += 1
      state.lastError = (err && err.message) || 'SEARCH_FAILED'
      log('info', 'roomSearch search failed', { message: state.lastError })
      return []
    }
    state.stats.searches += 1
    if (!Array.isArray(rows)) return []
    const hits = []
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue
      const id = typeof r.id === 'string' ? r.id : ''
      // Prefer the SDK's returned content; fall back to our own docText mirror
      // (some SDK builds return only {id, score}).
      const content = typeof r.content === 'string' && r.content.length > 0
        ? r.content
        : (docText.get(id) || '')
      if (content.length === 0) continue
      const score = Number(r.score) || 0
      const meta = docMeta.get(id) || {}
      hits.push({
        msgId: meta.msgId || null,
        author: meta.author || null,
        at: meta.at || null,
        snippet: content.slice(0, 240),
        score
      })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, topK)
  }

  async function close () {
    state.closed = true
    if (state.reindexTimer) {
      try { clearTimeout(state.reindexTimer) } catch { /* noop */ }
      state.reindexTimer = null
    }
    // Close the workspace (persist on disk). We deliberately do NOT
    // deleteOnClose so a re-open of the same room finds its embeddings.
    if (state.sdk && typeof state.sdk.ragCloseWorkspace === 'function') {
      try {
        await state.sdk.ragCloseWorkspace({ workspace: state.workspace })
      } catch (err) {
        log('info', 'roomSearch close threw', { message: err && err.message })
      }
    }
  }

  return {
    ingestMessage,
    search,
    reindexAll,
    scheduleDebouncedReindex,
    status,
    close,
    // Test seams
    _internal: { state, docMeta, docText, ingestIdFor, sanitizeText, workspace }
  }
}

/**
 * Word-boundary chunker used to produce deterministic per-message chunks.
 * We keep this internal so ingestion has stable chunk ids across reindex.
 */
function simpleChunk (text, size, overlap) {
  if (typeof text !== 'string' || text.length === 0) return []
  if (text.length <= size) return [text]
  const out = []
  let i = 0
  const step = Math.max(1, size - Math.max(0, overlap))
  while (i < text.length) {
    let end = Math.min(text.length, i + size)
    if (end < text.length) {
      // Try to end at a word boundary (space) within the last 20 chars
      const back = text.lastIndexOf(' ', end)
      if (back > i + Math.floor(size / 2)) end = back
    }
    const chunk = text.slice(i, end).trim()
    if (chunk.length > 0) out.push(chunk)
    if (end >= text.length) break
    i += step
  }
  return out
}

module.exports = {
  createRoomSearch,
  workspaceForRoom,
  sanitizeText,
  flagEnabled,
  simpleChunk,
  DEFAULT_EMBED_MODEL_SRC,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_TOP_K,
  MAX_TOP_K,
  MAX_QUERY_CHARS,
  MAX_TEXT_CHARS,
  HISTORY_REINDEX_LIMIT,
  DEBOUNCE_REINDEX_MS
}
