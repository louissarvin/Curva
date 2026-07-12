// Curva RAG helper.
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

// Wave-final QVAC polish (F2) --------------------------------------------
//
// Docs-verification memo for the added lifecycle surface
//
// Ground truth (installed):
//   pear-app/node_modules/@qvac/sdk/dist/client/api/rag.d.ts
//     - ragChunk({documents, chunkOpts}) : Promise<RagDoc[]>
//     - ragReindex({workspace}) : Promise<RagReindexResult>
//         result shape: { reindexed:boolean, details?:{reason?:string, ...} }
//         Requires >= 16 docs (HyperDB) or reindexed=false with details.
//     - ragCloseWorkspace({workspace, deleteOnClose?}) : Promise<void>
//     - ragDeleteWorkspace({workspace}) : Promise<void>
//
// Periodic reindex scheduler:
//   Every REINDEX_INGEST_THRESHOLD ingests to a workspace schedules a debounced
//   reindex (REINDEX_DEBOUNCE_MS after the last ingest). Emits
//   `rag:reindexed {workspace, durationMs, reindexed, reason?}`.
//   Feature flag CURVA_RAG_REINDEX_ENABLED (default: on) suppresses scheduling
//   entirely when set to '0' or 'false'.
const REINDEX_INGEST_THRESHOLD = 100
const REINDEX_DEBOUNCE_MS = 5_000
const REINDEX_MAX_DURATION_MS = 60_000

function reindexFlagEnabled () {
  try {
    const raw = (typeof process !== 'undefined' && process.env &&
      process.env.CURVA_RAG_REINDEX_ENABLED) || ''
    if (raw === '') return true  // default ON
    const s = String(raw).toLowerCase()
    return s === '1' || s === 'true' || s === 'yes' || s === 'on'
  } catch { return true }
}

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
    hasIngest: false,
    // Wave-final QVAC polish (F2): periodic reindex bookkeeping. Per-workspace
    // ingest counter; when it crosses REINDEX_INGEST_THRESHOLD we (re)schedule
    // a debounced reindex. Timers are cleared on close() so a stray reindex
    // cannot fire against a closed workspace. Map value shape:
    //   { count:number, timer:Timeout|null, inFlight:boolean }
    reindexBookkeeping: new Map(),
    reindexEnabled: reindexFlagEnabled(),
    reindexTotal: 0,
    closed: false
  }

  function status () {
    return {
      ready: state.ready,
      modelId: state.modelId,
      modelSrc: state.modelSrc,
      workspaces: Array.from(state.workspaces),
      lastError: state.lastError,
      hasIngest: state.hasIngest,
      // Wave-final QVAC polish (F2) observability
      reindexEnabled: !!state.reindexEnabled,
      reindexTotal: state.reindexTotal,
      pendingReindexes: Array.from(state.reindexBookkeeping.entries())
        .filter(([, v]) => !!v.timer || !!v.inFlight)
        .map(([ws]) => ws)
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
      // NOTE (2026-07-11 semifinal debug): SDK rejects the pair
      // `{modelSrc: 'llamacpp-embedding', modelType: 'embedding'}` with the
      // "modelSrc describes 'llamacpp-embedding' but modelType resolves to
      // 'embedding'" MODEL_TYPE_MISMATCH error. Omit modelType and let the
      // SDK infer from modelSrc. Same shape as bare/roomSearch.js:189.
      let modelId
      try {
        modelId = await sdk.loadModel({
          modelSrc: resolved,
          onProgress: (p) => emit('rag:progress', {
            modelSrc: embedModelSrc,
            percentage: p?.percentage ?? p?.percent ?? null,
            downloaded: p?.downloaded ?? null,
            total: p?.total ?? null
          })
        })
      } catch (loadErr) {
        // MODEL_ALREADY_REGISTERED: roomSearch (or a previous rag boot) has
        // already loaded the same embedding model in this worker. Reuse the
        // existing modelId via getLoadedModelInfo. Same shape as the fix in
        // bare/roomSearch.js.
        const msg = (loadErr && loadErr.message) || ''
        if (msg.indexOf('already registered') >= 0 && typeof sdk.getLoadedModelInfo === 'function') {
          try {
            const info = await sdk.getLoadedModelInfo({})
            const loaded = Array.isArray(info) ? info : (info && info.models) || []
            const embedEntry = loaded.find(function (m) {
              const addon = (m && (m.addon || m.pluginName)) || ''
              return String(addon).indexOf('embedding') >= 0
            }) || loaded[0]
            if (embedEntry && embedEntry.modelId) {
              modelId = embedEntry.modelId
              log('info', 'rag reusing already-loaded embedding model', { modelId })
            } else {
              throw loadErr
            }
          } catch (infoErr) {
            state.lastError = loadErr.message || 'load failed'
            emit('rag:error', { code: 'LOAD_FAILED', message: state.lastError })
            log('warn', 'rag getLoadedModelInfo failed after already-registered', {
              loadMsg: state.lastError, infoMsg: infoErr && infoErr.message
            })
            return false
          }
        } else {
          throw loadErr
        }
      }
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
      // Wave-final QVAC polish (F2): bump the per-workspace ingest counter and
      // debounce a reindex. bumpAndMaybeSchedule() is a noop when the feature
      // flag is off (CURVA_RAG_REINDEX_ENABLED=0) or the SDK does not expose
      // ragReindex. Only counts successfully-processed docs so a batch that
      // was fully dropped does not trip the threshold.
      if (processed > 0) bumpAndMaybeScheduleReindex(workspace, processed)
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

  // Wave-final QVAC polish (F2) -----------------------------------------
  //
  // Public lifecycle wrappers. All are idempotent + graceful: they resolve
  // with `{ok:false, reason}` on failure instead of throwing so a caller
  // sequencing chunk -> ingest -> reindex does not need a try/catch chain.

  /**
   * Wrap ragChunk.
   * @param {{ workspace?: string, document?: string|string[], chunkOpts?: object }} opts
   * @returns {Promise<{ ok:boolean, chunks?:Array, reason?:string }>}
   */
  async function chunk ({ workspace, document, chunkOpts } = {}) {
    if (document == null) return { ok: false, reason: 'EMPTY_DOCUMENT' }
    const docs = Array.isArray(document)
      ? document.filter((d) => typeof d === 'string' && d.length > 0)
      : (typeof document === 'string' && document.length > 0 ? [document] : [])
    if (docs.length === 0) return { ok: false, reason: 'EMPTY_DOCUMENT' }
    if (docs.length > MAX_DOC_BATCH) docs.length = MAX_DOC_BATCH
    const ready = await ensureReady()
    if (!ready) return { ok: false, reason: 'NOT_READY' }
    if (!state.sdk || typeof state.sdk.ragChunk !== 'function') {
      return { ok: false, reason: 'CHUNK_UNAVAILABLE' }
    }
    try {
      const params = { documents: docs }
      if (chunkOpts && typeof chunkOpts === 'object') params.chunkOpts = chunkOpts
      const chunks = await state.sdk.ragChunk(params)
      const arr = Array.isArray(chunks) ? chunks : []
      emit('rag:chunked', {
        workspace: workspace || null,
        docCount: docs.length,
        chunkCount: arr.length
      })
      return { ok: true, chunks: arr }
    } catch (err) {
      state.lastError = (err && err.message) || 'chunk failed'
      emit('rag:error', { code: err?.code || 'CHUNK_FAILED', message: state.lastError, workspace: workspace || null })
      return { ok: false, reason: 'CHUNK_FAILED' }
    }
  }

  /**
   * Wrap ragReindex. Called on-demand by the scheduler or by tests.
   * @param {{ workspace?: string }} opts
   * @returns {Promise<{ ok:boolean, reindexed?:boolean, reason?:string, durationMs?:number, details?:object }>}
   */
  async function reindex ({ workspace } = {}) {
    if (typeof workspace !== 'string' || workspace.length === 0) {
      return { ok: false, reason: 'BAD_WORKSPACE' }
    }
    if (state.closed) return { ok: false, reason: 'CLOSED' }
    const ready = await ensureReady()
    if (!ready) return { ok: false, reason: 'NOT_READY' }
    if (!state.sdk || typeof state.sdk.ragReindex !== 'function') {
      return { ok: false, reason: 'REINDEX_UNAVAILABLE' }
    }
    const book = state.reindexBookkeeping.get(workspace) || { count: 0, timer: null, inFlight: false }
    // Skip if a reindex is already in flight for this workspace; the caller
    // should await the previous one before scheduling another.
    if (book.inFlight) return { ok: false, reason: 'IN_FLIGHT' }
    book.inFlight = true
    state.reindexBookkeeping.set(workspace, book)
    const started = Date.now()
    try {
      const res = await state.sdk.ragReindex({ workspace })
      const durationMs = Date.now() - started
      const wasReindexed = !!(res && res.reindexed)
      // Reset the ingest counter only when the SDK confirmed reindex happened;
      // otherwise a below-min-doc-count workspace would loop forever without a
      // successful reindex.
      if (wasReindexed) book.count = 0
      book.inFlight = false
      state.reindexBookkeeping.set(workspace, book)
      state.reindexTotal += 1
      emit('rag:reindexed', {
        workspace,
        durationMs,
        reindexed: wasReindexed,
        reason: res?.details?.reason || null
      })
      return { ok: true, reindexed: wasReindexed, durationMs, details: res?.details || null }
    } catch (err) {
      book.inFlight = false
      state.reindexBookkeeping.set(workspace, book)
      state.lastError = (err && err.message) || 'reindex failed'
      emit('rag:error', { code: err?.code || 'REINDEX_FAILED', message: state.lastError, workspace })
      return { ok: false, reason: 'REINDEX_FAILED' }
    }
  }

  /**
   * Debounce scheduler. Called from ingest().
   * @param {string} workspace
   * @param {number} processed
   */
  function bumpAndMaybeScheduleReindex (workspace, processed) {
    if (!state.reindexEnabled) return
    if (state.closed) return
    if (!state.sdk || typeof state.sdk.ragReindex !== 'function') return
    const book = state.reindexBookkeeping.get(workspace) || { count: 0, timer: null, inFlight: false }
    book.count += Math.max(0, Number(processed) || 0)
    state.reindexBookkeeping.set(workspace, book)
    if (book.count < REINDEX_INGEST_THRESHOLD) return
    // Debounce: clear any pending timer and start a fresh one. Prevents
    // reindex thrash while a batch ingest is still landing.
    if (book.timer) {
      try { clearTimeout(book.timer) } catch { /* noop */ }
    }
    book.timer = setTimeout(() => {
      book.timer = null
      state.reindexBookkeeping.set(workspace, book)
      // Fire-and-forget. reindex() is idempotent + gated on inFlight.
      reindex({ workspace }).catch((err) => {
        log('warn', 'scheduled reindex threw', { workspace, message: err && err.message })
      })
    }, REINDEX_DEBOUNCE_MS)
    // Do not keep the process alive purely to fire a reindex.
    try { book.timer.unref && book.timer.unref() } catch { /* noop */ }
    state.reindexBookkeeping.set(workspace, book)
    emit('rag:reindex-scheduled', { workspace, count: book.count })
  }

  /**
   * Wrap ragCloseWorkspace. Idempotent and safe when the SDK does not ship it.
   * @param {{ workspace?: string, deleteOnClose?: boolean }} opts
   * @returns {Promise<{ ok:boolean, reason?:string }>}
   */
  async function closeWorkspace ({ workspace, deleteOnClose = false } = {}) {
    if (typeof workspace !== 'string' || workspace.length === 0) {
      return { ok: false, reason: 'BAD_WORKSPACE' }
    }
    // Cancel any pending reindex timer for this workspace so we do not fire
    // against a workspace we just released.
    const book = state.reindexBookkeeping.get(workspace)
    if (book && book.timer) {
      try { clearTimeout(book.timer) } catch { /* noop */ }
      book.timer = null
    }
    if (!state.sdk || typeof state.sdk.ragCloseWorkspace !== 'function') {
      return { ok: false, reason: 'CLOSE_UNAVAILABLE' }
    }
    try {
      await state.sdk.ragCloseWorkspace({ workspace, deleteOnClose: !!deleteOnClose })
      state.workspaces.delete(workspace)
      state.reindexBookkeeping.delete(workspace)
      emit('rag:workspace-closed', { workspace, deleted: !!deleteOnClose })
      return { ok: true }
    } catch (err) {
      state.lastError = (err && err.message) || 'closeWorkspace failed'
      emit('rag:error', { code: err?.code || 'CLOSE_FAILED', message: state.lastError, workspace })
      return { ok: false, reason: 'CLOSE_FAILED' }
    }
  }

  /**
   * Wrap ragDeleteWorkspace. The SDK contract requires the workspace to be
   * closed first; we handle that transparently.
   * @param {{ workspace?: string }} opts
   * @returns {Promise<{ ok:boolean, reason?:string }>}
   */
  async function deleteWorkspace ({ workspace } = {}) {
    if (typeof workspace !== 'string' || workspace.length === 0) {
      return { ok: false, reason: 'BAD_WORKSPACE' }
    }
    // Best-effort close first (SDK contract). Ignore its result: if the
    // workspace was never opened, close will fail but delete may still work.
    if (state.sdk && typeof state.sdk.ragCloseWorkspace === 'function') {
      try { await state.sdk.ragCloseWorkspace({ workspace }) } catch { /* noop */ }
    }
    if (!state.sdk || typeof state.sdk.ragDeleteWorkspace !== 'function') {
      return { ok: false, reason: 'DELETE_UNAVAILABLE' }
    }
    try {
      await state.sdk.ragDeleteWorkspace({ workspace })
      state.workspaces.delete(workspace)
      state.reindexBookkeeping.delete(workspace)
      emit('rag:workspace-deleted', { workspace })
      return { ok: true }
    } catch (err) {
      state.lastError = (err && err.message) || 'deleteWorkspace failed'
      emit('rag:error', { code: err?.code || 'DELETE_FAILED', message: state.lastError, workspace })
      return { ok: false, reason: 'DELETE_FAILED' }
    }
  }

  /**
   * Close one or all workspaces. Called on room close.
   */
  async function close (closeOpts = {}) {
    const { workspace = null, deleteOnClose = false } = closeOpts || {}
    // Wave-final QVAC polish (F2): flip closed BEFORE tearing down timers so a
    // concurrent bumpAndMaybeScheduleReindex is a no-op and we do not race a
    // fresh timer against the shutdown path.
    if (!workspace) state.closed = true
    // Cancel every pending reindex timer for the targeted workspaces so the
    // shutdown path is idempotent.
    const timerTargets = workspace ? [workspace] : Array.from(state.reindexBookkeeping.keys())
    for (const ws of timerTargets) {
      const book = state.reindexBookkeeping.get(ws)
      if (book && book.timer) {
        try { clearTimeout(book.timer) } catch { /* noop */ }
        book.timer = null
      }
    }
    if (!state.sdk || typeof state.sdk.ragCloseWorkspace !== 'function') return
    const targets = workspace ? [workspace] : Array.from(state.workspaces)
    for (const ws of targets) {
      try {
        await state.sdk.ragCloseWorkspace({ workspace: ws, deleteOnClose: !!deleteOnClose })
        state.workspaces.delete(ws)
        state.reindexBookkeeping.delete(ws)
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
    // Wave-final QVAC polish (F2) additions
    chunk,
    reindex,
    closeWorkspace,
    deleteWorkspace,
    workspaceFor: (kind) => workspaceFor(roomSlug, kind),
    _internal: { state, bumpAndMaybeScheduleReindex }
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
  reindexFlagEnabled,
  DEFAULT_EMBED_MODEL_SRC,
  DEFAULT_TOP_K,
  MAX_QUERY_CHARS,
  MAX_DOC_BATCH,
  MAX_WORKSPACES,
  REINDEX_INGEST_THRESHOLD,
  REINDEX_DEBOUNCE_MS,
  REINDEX_MAX_DURATION_MS
}
