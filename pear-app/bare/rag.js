// Curva RAG helper (Semifinal QVAC depth).
//
// Docs-verification memo ---------------------------------------------------
//
// Source of truth is the installed @qvac/sdk 0.14.0 at
// pear-app/node_modules/@qvac/sdk/dist/client/api/rag.d.ts and embed.d.ts.
// Fetched https://docs.qvac.tether.io/ai-capabilities/rag/ on 2026-07-10.
//
//   ragIngest({ modelId, workspace, documents, chunk?, chunkOpts?, onProgress? })
//     -> Promise<{ processed: RagSaveEmbeddingsResult[], droppedIndices: number[] }>
//   ragSearch({ modelId, workspace, query, topK?, n? })
//     -> Promise<Array<{ id, content, score, ... }>>
//   embed({ modelId, text })  // string or string[]
//     -> Promise<{ embedding: number[]|number[][] }>
//   ragCloseWorkspace({ workspace, deleteOnClose? })
//
// Model choice: `EMBEDDINGGEMMA_300M_Q4_0` (registry constant exported from
// @qvac/sdk). Verified in dist/models/registry/models.js. It is a real small
// embedding model quantised to ~200 MB. If callers want a different one they
// can pass `embedModelSrc: 'EMBEDDINGGEMMA_300M_F32'` etc.
//
// Workspace naming convention: `curva/room/<slug>/<kind>` where kind is one
// of `glossary`, `chat`. Callers ingest football glossary once at room open,
// chat messages on every send. Search fans out over both workspaces and
// returns a merged top-K.
//
// Failure posture: if the SDK's rag plugin is unavailable at boot (older SDK,
// dev harness) the module degrades to a null-object: search() returns [] and
// ingest() is a no-op. The commentator/roomBot then run un-grounded.

const DEFAULT_EMBED_MODEL_SRC = 'EMBEDDINGGEMMA_300M_Q4_0'
const DEFAULT_TOP_K = 3
const MAX_QUERY_CHARS = 1024
const MAX_DOC_BATCH = 128        // hard cap so a malicious peer cannot spam ingest
const MAX_WORKSPACES = 32        // per-room cap so we do not leak vector DBs

function slugifyWorkspacePart (s) {
  return String(s || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'default'
}

function workspaceFor (roomSlug, kind) {
  return 'curva/room/' + slugifyWorkspacePart(roomSlug) + '/' + slugifyWorkspacePart(kind || 'default')
}

/**
 * @param {{
 *   sdkImpl?: object,          // test seam: {loadModel, embed, ragIngest, ragSearch, ragCloseWorkspace, unloadModel?}
 *   embedModelSrc?: string,
 *   roomSlug?: string,
 *   emit?: (event:string, payload:any) => void,
 *   log?: (level:string, msg:string, extra?:any) => void
 * }} opts
 */
function createRag (opts = {}) {
  const {
    sdkImpl = null,
    embedModelSrc = DEFAULT_EMBED_MODEL_SRC,
    roomSlug = 'default',
    emit = () => {},
    log = () => {}
  } = opts

  const state = {
    ready: false,
    modelId: null,
    modelSrc: embedModelSrc,
    // Workspaces we have touched during this room lifetime. Iteration order
    // is preserved so close() can tear them down deterministically.
    workspaces: new Set(),
    sdk: null,
    lastError: null,
    // Whether ragIngest is available. Older SDK builds may only ship search.
    hasIngest: false
  }

  function status () {
    return {
      ready: state.ready,
      modelId: state.modelId,
      modelSrc: state.modelSrc,
      workspaces: Array.from(state.workspaces),
      lastError: state.lastError,
      hasIngest: state.hasIngest
    }
  }

  async function resolveSdk () {
    if (state.sdk) return state.sdk
    if (sdkImpl) { state.sdk = sdkImpl; return state.sdk }
    try {
      const mod = await import('@qvac/sdk').catch(() => null)
      state.sdk = mod || null
    } catch { state.sdk = null }
    return state.sdk
  }

  async function ensureReady () {
    if (state.ready && state.modelId) return true
    const sdk = await resolveSdk()
    if (!sdk || typeof sdk.loadModel !== 'function' || typeof sdk.embed !== 'function' || typeof sdk.ragSearch !== 'function') {
      state.lastError = 'RAG API unavailable in @qvac/sdk'
      emit('rag:error', { code: 'RAG_UNAVAILABLE', message: state.lastError })
      return false
    }
    // Some builds may not ship ragIngest yet; degrade to search-only.
    state.hasIngest = typeof sdk.ragIngest === 'function'
    try {
      // Resolve registry constant if the SDK exposes it (same trick as
      // commentator.js). If callers pass an already-resolved value, this
      // no-ops.
      const resolved = (typeof embedModelSrc === 'string' && sdk[embedModelSrc] !== undefined)
        ? sdk[embedModelSrc]
        : embedModelSrc
      emit('rag:loading', { modelSrc: embedModelSrc })
      const modelId = await sdk.loadModel({
        modelSrc: resolved,
        modelType: 'embedding',
        onProgress: (p) => emit('rag:progress', {
          modelSrc: embedModelSrc,
          percentage: p?.percentage ?? p?.percent ?? null,
          downloaded: p?.downloaded ?? null,
          total: p?.total ?? null
        })
      })
      if (typeof modelId !== 'string' || modelId.length === 0) {
        state.lastError = 'loadModel returned no modelId'
        emit('rag:error', { code: 'LOAD_FAILED', message: state.lastError })
        return false
      }
      state.modelId = modelId
      state.ready = true
      state.lastError = null
      emit('rag:ready', { modelId, modelSrc: embedModelSrc })
      return true
    } catch (err) {
      state.lastError = (err && err.message) || 'load failed'
      emit('rag:error', { code: err?.code || 'LOAD_FAILED', message: state.lastError })
      log('warn', 'rag load failed', { message: state.lastError })
      return false
    }
  }

  /**
   * Ingest documents into a workspace.
   * @param {Array<string>|string} docs
   * @param {{ workspace?: string, kind?: string, chunk?: boolean, chunkOpts?: object }} [ingestOpts]
   * @returns {Promise<{ ok: boolean, processed?: number, dropped?: number, workspace?: string, reason?: string }>}
   */
  async function ingest (docs, ingestOpts = {}) {
    const documents = Array.isArray(docs)
      ? docs.filter((d) => typeof d === 'string' && d.length > 0)
      : (typeof docs === 'string' && docs.length > 0 ? [docs] : [])
    if (documents.length === 0) return { ok: false, reason: 'EMPTY_DOCS' }
    // Code review fix (High): log + emit when a batch is silently truncated so
    // the caller/UI sees the drop instead of assuming the whole batch landed.
    if (documents.length > MAX_DOC_BATCH) {
      const droppedByCap = documents.length - MAX_DOC_BATCH
      documents.length = MAX_DOC_BATCH
      log('warn', 'rag ingest batch truncated', { requested: MAX_DOC_BATCH + droppedByCap, kept: MAX_DOC_BATCH, dropped: droppedByCap })
      emit('rag:truncated', { dropped: droppedByCap, kept: MAX_DOC_BATCH })
    }

    const ready = await ensureReady()
    if (!ready) return { ok: false, reason: 'NOT_READY' }
    if (!state.hasIngest) return { ok: false, reason: 'INGEST_UNAVAILABLE' }

    const workspace = ingestOpts.workspace || workspaceFor(roomSlug, ingestOpts.kind || 'default')
    if (state.workspaces.size >= MAX_WORKSPACES && !state.workspaces.has(workspace)) {
      return { ok: false, reason: 'WORKSPACE_LIMIT' }
    }
    try {
      const res = await state.sdk.ragIngest({
        modelId: state.modelId,
        workspace,
        documents,
        chunk: ingestOpts.chunk !== false,
        chunkOpts: ingestOpts.chunkOpts || undefined
      })
      state.workspaces.add(workspace)
      const processed = Array.isArray(res?.processed) ? res.processed.length : 0
      const dropped = Array.isArray(res?.droppedIndices) ? res.droppedIndices.length : 0
      emit('rag:ingested', { workspace, processed, dropped })
      return { ok: true, processed, dropped, workspace }
    } catch (err) {
      state.lastError = (err && err.message) || 'ingest failed'
      emit('rag:error', { code: err?.code || 'INGEST_FAILED', message: state.lastError, workspace })
      log('warn', 'rag ingest failed', { message: state.lastError, workspace })
      return { ok: false, reason: 'INGEST_FAILED' }
    }
  }

  /**
   * Search a workspace (or the merged room set) for top-K matches.
   *
   * @param {string} query
   * @param {{
   *   workspace?: string,
   *   workspaces?: Array<string>,   // multi-workspace merge
   *   kind?: string,                // if workspace/workspaces omitted, use `curva/room/<slug>/<kind>`
   *   topK?: number
   * }} [searchOpts]
   * @returns {Promise<Array<{ id?:string, content:string, score:number, workspace:string }>>}
   */
  async function search (query, searchOpts = {}) {
    if (typeof query !== 'string' || query.trim().length === 0) return []
    const q = query.trim().slice(0, MAX_QUERY_CHARS)
    const ready = await ensureReady()
    if (!ready) return []

    const topK = Math.max(1, Math.min(10, Number(searchOpts.topK) || DEFAULT_TOP_K))
    let workspaces
    if (Array.isArray(searchOpts.workspaces) && searchOpts.workspaces.length > 0) {
      workspaces = searchOpts.workspaces.slice(0, MAX_WORKSPACES)
    } else if (typeof searchOpts.workspace === 'string' && searchOpts.workspace.length > 0) {
      workspaces = [searchOpts.workspace]
    } else if (typeof searchOpts.kind === 'string') {
      workspaces = [workspaceFor(roomSlug, searchOpts.kind)]
    } else {
      // Default: merge all workspaces we have touched for this room.
      workspaces = Array.from(state.workspaces)
      if (workspaces.length === 0) {
        // Fallback: the two conventional room workspaces.
        workspaces = [workspaceFor(roomSlug, 'glossary'), workspaceFor(roomSlug, 'chat')]
      }
    }

    const perWorkspaceK = Math.max(1, Math.min(topK, 5))
    const merged = []
    for (const ws of workspaces) {
      try {
        const rows = await state.sdk.ragSearch({
          modelId: state.modelId,
          workspace: ws,
          query: q,
          topK: perWorkspaceK
        })
        if (Array.isArray(rows)) {
          for (const r of rows) {
            if (!r || typeof r !== 'object') continue
            const content = typeof r.content === 'string' ? r.content : ''
            const score = Number(r.score) || 0
            if (content.length === 0) continue
            merged.push({
              id: typeof r.id === 'string' ? r.id : null,
              content,
              score,
              workspace: ws
            })
          }
        }
      } catch (err) {
        // Missing workspace or search error: skip, do not fail the caller.
        log('info', 'rag search skipped workspace', { workspace: ws, message: err?.message })
      }
    }
    merged.sort((a, b) => b.score - a.score)
    const out = merged.slice(0, topK)
    emit('rag:searched', { query: q.slice(0, 120), count: out.length, top: out[0]?.score ?? null })
    return out
  }

  /**
   * Close one or all workspaces. Called on room close.
   */
  async function close (closeOpts = {}) {
    const { workspace = null, deleteOnClose = false } = closeOpts || {}
    if (!state.sdk || typeof state.sdk.ragCloseWorkspace !== 'function') return
    const targets = workspace ? [workspace] : Array.from(state.workspaces)
    for (const ws of targets) {
      try {
        await state.sdk.ragCloseWorkspace({ workspace: ws, deleteOnClose: !!deleteOnClose })
        state.workspaces.delete(ws)
      } catch (err) {
        log('warn', 'ragCloseWorkspace failed', { workspace: ws, message: err?.message })
      }
    }
    // Unload the embed model only when we close ALL workspaces.
    if (!workspace && state.modelId && state.sdk && typeof state.sdk.unloadModel === 'function') {
      try { await state.sdk.unloadModel({ modelId: state.modelId }) } catch { /* noop */ }
      state.modelId = null
      state.ready = false
    }
  }

  return {
    ingest,
    search,
    close,
    ensureReady,
    status,
    workspaceFor: (kind) => workspaceFor(roomSlug, kind),
    _internal: { state }
  }
}

/**
 * Convert the `bare/glossary.json` structure to ingest-ready English sentences.
 * We turn each row into a short "term (translations)" sentence so the embed
 * model can index both the source term and its translations for cross-lingual
 * retrieval. Non-string values are skipped defensively.
 */
function glossaryToDocuments (glossary, opts = {}) {
  if (!glossary || !Array.isArray(glossary.terms)) return []
  const { limit = 200 } = opts
  const out = []
  for (const row of glossary.terms) {
    if (!row || typeof row !== 'object') continue
    const en = typeof row.en === 'string' ? row.en.trim() : ''
    if (en.length === 0) continue
    const parts = []
    for (const [lang, value] of Object.entries(row)) {
      if (lang === 'en') continue
      if (typeof value === 'string' && value.trim().length > 0) {
        parts.push(lang + ':' + value.trim())
      }
    }
    const doc = 'football term "' + en + '"' +
      (parts.length > 0 ? ' (' + parts.join(', ') + ')' : '')
    out.push(doc)
    if (out.length >= limit) break
  }
  return out
}

module.exports = {
  createRag,
  glossaryToDocuments,
  workspaceFor,
  slugifyWorkspacePart,
  DEFAULT_EMBED_MODEL_SRC,
  DEFAULT_TOP_K,
  MAX_QUERY_CHARS,
  MAX_DOC_BATCH,
  MAX_WORKSPACES
}
