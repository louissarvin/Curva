// Wave-final QVAC polish (F2) brittle tests: RAG lifecycle wrappers +
// periodic reindex scheduler.
//
// Docs-verification memo ---------------------------------------------------
//
// Source of truth is @qvac/sdk 0.14.0 at
//   pear-app/node_modules/@qvac/sdk/dist/client/api/rag.d.ts
//     ragChunk({documents, chunkOpts}) : Promise<RagDoc[]>
//     ragReindex({workspace}) : Promise<{reindexed:boolean, details?:{reason?:string}}>
//     ragCloseWorkspace({workspace, deleteOnClose?}) : Promise<void>
//     ragDeleteWorkspace({workspace}) : Promise<void>
//
// The scheduler contract (bumped every 100 ingested docs, 5s debounce) is
// exercised via fake timers by driving ingests directly and asserting the
// reindex call fires after the debounce window.

const test = require('brittle')
const {
  createRag,
  reindexFlagEnabled,
  REINDEX_INGEST_THRESHOLD,
  REINDEX_DEBOUNCE_MS
} = require('../bare/rag.js')

// --- Fake @qvac/sdk (mirrors dist/client/api/rag.d.ts) --------------------

function makeFakeSdk ({
  reindexResult = { reindexed: true, details: null },
  failReindex = false,
  failClose = false,
  failDelete = false,
  chunkOut = null
} = {}) {
  const workspaces = new Map()
  const calls = {
    loadModel: 0,
    ragIngest: 0,
    ragSearch: 0,
    ragChunk: 0,
    ragChunkArgs: [],
    ragReindex: 0,
    ragReindexArgs: [],
    ragCloseWorkspace: 0,
    ragCloseArgs: [],
    ragDeleteWorkspace: 0,
    ragDeleteArgs: [],
    embed: 0,
    unloadModel: 0
  }
  let modelSeq = 0
  return {
    EMBEDDINGGEMMA_300M_Q4_0: { name: 'stub' },
    async loadModel ({ modelSrc, modelType }) {
      calls.loadModel += 1
      if (!modelSrc || modelType !== 'embedding') throw new Error('bad load')
      return 'embed-model-' + (++modelSeq)
    },
    async ragIngest ({ modelId, workspace, documents }) {
      calls.ragIngest += 1
      const store = workspaces.get(workspace) || []
      documents.forEach((d, i) => {
        store.push({ id: workspace + '#' + (store.length + i), content: String(d) })
      })
      workspaces.set(workspace, store)
      return { processed: documents.map(() => ({ id: 'x' })), droppedIndices: [] }
    },
    async ragSearch () { calls.ragSearch += 1; return [] },
    async embed () { calls.embed += 1; return { embedding: [0, 1, 2] } },
    async ragChunk (params) {
      calls.ragChunk += 1
      calls.ragChunkArgs.push(params)
      if (chunkOut) return chunkOut
      // Default: return one RagDoc per source document.
      const docs = Array.isArray(params.documents) ? params.documents : [params.documents]
      return docs.map((d, i) => ({ id: 'chunk-' + i, content: String(d).slice(0, 80) }))
    },
    async ragReindex (params) {
      calls.ragReindex += 1
      calls.ragReindexArgs.push(params)
      if (failReindex) throw new Error('reindex failed')
      return reindexResult
    },
    async ragCloseWorkspace (params) {
      calls.ragCloseWorkspace += 1
      calls.ragCloseArgs.push(params)
      if (failClose) throw new Error('close failed')
      workspaces.delete(params.workspace)
    },
    async ragDeleteWorkspace (params) {
      calls.ragDeleteWorkspace += 1
      calls.ragDeleteArgs.push(params)
      if (failDelete) throw new Error('delete failed')
      workspaces.delete(params.workspace)
    },
    async unloadModel () { calls.unloadModel += 1 },
    _peek: { workspaces, calls }
  }
}

function collectEmits () {
  const events = []
  return { events, emit: (e, p) => events.push({ e, p }) }
}

// -- reindexFlagEnabled ----------------------------------------------------

test('reindexFlagEnabled defaults to true when env unset', async (t) => {
  const prev = process.env.CURVA_RAG_REINDEX_ENABLED
  delete process.env.CURVA_RAG_REINDEX_ENABLED
  t.ok(reindexFlagEnabled(), 'default ON')
  process.env.CURVA_RAG_REINDEX_ENABLED = '0'
  t.absent(reindexFlagEnabled(), 'CURVA_RAG_REINDEX_ENABLED=0 disables')
  process.env.CURVA_RAG_REINDEX_ENABLED = 'false'
  t.absent(reindexFlagEnabled(), 'false disables')
  process.env.CURVA_RAG_REINDEX_ENABLED = 'yes'
  t.ok(reindexFlagEnabled(), 'yes enables')
  if (prev === undefined) delete process.env.CURVA_RAG_REINDEX_ENABLED
  else process.env.CURVA_RAG_REINDEX_ENABLED = prev
})

// -- chunk wrapper ---------------------------------------------------------

test('chunk() delegates to sdk.ragChunk with the right shape', async (t) => {
  const sdk = makeFakeSdk()
  const { emit, events } = collectEmits()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'room-a', emit })
  await rag.ensureReady()
  const res = await rag.chunk({
    workspace: 'ws-a',
    document: ['doc-1', 'doc-2'],
    chunkOpts: { chunkSize: 256, chunkOverlap: 30, chunkStrategy: 'paragraph' }
  })
  t.ok(res.ok, 'chunk succeeded')
  t.is(res.chunks.length, 2, 'returned 2 chunks')
  t.is(sdk._peek.calls.ragChunk, 1, 'sdk.ragChunk called once')
  const args = sdk._peek.calls.ragChunkArgs[0]
  t.alike(args.documents, ['doc-1', 'doc-2'], 'documents forwarded')
  t.alike(args.chunkOpts, { chunkSize: 256, chunkOverlap: 30, chunkStrategy: 'paragraph' }, 'chunkOpts forwarded')
  t.ok(events.some((e) => e.e === 'rag:chunked'), 'rag:chunked event emitted')
})

test('chunk() rejects empty document with EMPTY_DOCUMENT', async (t) => {
  const sdk = makeFakeSdk()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'x' })
  await rag.ensureReady()
  const r1 = await rag.chunk({ workspace: 'w', document: null })
  t.is(r1.reason, 'EMPTY_DOCUMENT', 'null document rejected')
  const r2 = await rag.chunk({ workspace: 'w', document: [] })
  t.is(r2.reason, 'EMPTY_DOCUMENT', 'empty array rejected')
  const r3 = await rag.chunk({ workspace: 'w', document: '' })
  t.is(r3.reason, 'EMPTY_DOCUMENT', 'empty string rejected')
})

test('chunk() returns CHUNK_UNAVAILABLE when SDK lacks ragChunk', async (t) => {
  const sdk = makeFakeSdk()
  delete sdk.ragChunk
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'x' })
  await rag.ensureReady()
  const res = await rag.chunk({ workspace: 'w', document: 'hello' })
  t.absent(res.ok, 'chunk fails')
  t.is(res.reason, 'CHUNK_UNAVAILABLE', 'reason surfaced')
})

// -- reindex wrapper -------------------------------------------------------

test('reindex() forwards workspace and returns reindexed flag', async (t) => {
  const sdk = makeFakeSdk({ reindexResult: { reindexed: true, details: null } })
  const { emit, events } = collectEmits()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'r', emit })
  await rag.ensureReady()
  const res = await rag.reindex({ workspace: 'my-ws' })
  t.ok(res.ok, 'reindex ok')
  t.ok(res.reindexed, 'reindexed=true propagates')
  t.is(sdk._peek.calls.ragReindex, 1, 'ragReindex called once')
  t.is(sdk._peek.calls.ragReindexArgs[0].workspace, 'my-ws', 'workspace forwarded')
  const emitted = events.find((e) => e.e === 'rag:reindexed')
  t.ok(emitted, 'rag:reindexed emitted')
  t.is(emitted.p.workspace, 'my-ws', 'event carries workspace')
  t.ok(typeof emitted.p.durationMs === 'number', 'event carries durationMs')
})

test('reindex() surfaces skip reason when reindexed=false', async (t) => {
  const sdk = makeFakeSdk({
    reindexResult: { reindexed: false, details: { reason: 'insufficient_documents' } }
  })
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'r' })
  await rag.ensureReady()
  const res = await rag.reindex({ workspace: 'small-ws' })
  t.ok(res.ok, 'call succeeded')
  t.absent(res.reindexed, 'reindexed=false surfaced')
  t.is(res.details.reason, 'insufficient_documents', 'details reason preserved')
})

test('reindex() rejects bad workspace input', async (t) => {
  const sdk = makeFakeSdk()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'r' })
  await rag.ensureReady()
  const r1 = await rag.reindex({})
  t.is(r1.reason, 'BAD_WORKSPACE', 'missing workspace rejected')
  const r2 = await rag.reindex({ workspace: '' })
  t.is(r2.reason, 'BAD_WORKSPACE', 'empty workspace rejected')
})

test('reindex() returns REINDEX_UNAVAILABLE when SDK lacks ragReindex', async (t) => {
  const sdk = makeFakeSdk()
  delete sdk.ragReindex
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'r' })
  await rag.ensureReady()
  const res = await rag.reindex({ workspace: 'w' })
  t.is(res.reason, 'REINDEX_UNAVAILABLE', 'reason surfaced')
})

test('reindex() surfaces REINDEX_FAILED when SDK throws', async (t) => {
  const sdk = makeFakeSdk({ failReindex: true })
  const { emit, events } = collectEmits()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'r', emit })
  await rag.ensureReady()
  const res = await rag.reindex({ workspace: 'w' })
  t.absent(res.ok, 'failed')
  t.is(res.reason, 'REINDEX_FAILED', 'reason surfaced')
  t.ok(events.some((e) => e.e === 'rag:error' && e.p.code === 'REINDEX_FAILED'), 'rag:error emitted')
})

// -- closeWorkspace + deleteWorkspace --------------------------------------

test('closeWorkspace() forwards to sdk and emits rag:workspace-closed', async (t) => {
  const sdk = makeFakeSdk()
  const { emit, events } = collectEmits()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'r', emit })
  await rag.ensureReady()
  const res = await rag.closeWorkspace({ workspace: 'ws-a', deleteOnClose: false })
  t.ok(res.ok, 'close ok')
  t.is(sdk._peek.calls.ragCloseWorkspace, 1, 'ragCloseWorkspace called')
  t.is(sdk._peek.calls.ragCloseArgs[0].workspace, 'ws-a', 'workspace forwarded')
  t.absent(sdk._peek.calls.ragCloseArgs[0].deleteOnClose, 'deleteOnClose forwarded as false')
  t.ok(events.some((e) => e.e === 'rag:workspace-closed'), 'rag:workspace-closed emitted')
})

test('closeWorkspace() rejects bad workspace', async (t) => {
  const sdk = makeFakeSdk()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'r' })
  await rag.ensureReady()
  const res = await rag.closeWorkspace({})
  t.is(res.reason, 'BAD_WORKSPACE', 'missing workspace rejected')
})

test('deleteWorkspace() calls close then delete', async (t) => {
  const sdk = makeFakeSdk()
  const { emit, events } = collectEmits()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'r', emit })
  await rag.ensureReady()
  const res = await rag.deleteWorkspace({ workspace: 'gone' })
  t.ok(res.ok, 'delete ok')
  t.is(sdk._peek.calls.ragCloseWorkspace, 1, 'close called first')
  t.is(sdk._peek.calls.ragDeleteWorkspace, 1, 'delete called')
  t.is(sdk._peek.calls.ragDeleteArgs[0].workspace, 'gone', 'workspace forwarded')
  t.ok(events.some((e) => e.e === 'rag:workspace-deleted'), 'rag:workspace-deleted emitted')
})

// -- periodic reindex scheduler --------------------------------------------

test('scheduler fires reindex after >= REINDEX_INGEST_THRESHOLD ingests + debounce', async (t) => {
  const sdk = makeFakeSdk({ reindexResult: { reindexed: true, details: null } })
  const { emit, events } = collectEmits()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'sched', emit })
  await rag.ensureReady()
  const ws = 'sched-ws'
  // One ingest of exactly THRESHOLD docs to cross the trigger.
  const docs = Array.from({ length: REINDEX_INGEST_THRESHOLD }, (_, i) => 'doc-' + i)
  const res = await rag.ingest(docs, { workspace: ws })
  t.ok(res.ok, 'ingest ok')
  // The scheduler is debounced by REINDEX_DEBOUNCE_MS; wait a hair longer.
  await new Promise((r) => setTimeout(r, REINDEX_DEBOUNCE_MS + 100))
  t.is(sdk._peek.calls.ragReindex, 1, 'reindex fired after debounce')
  t.ok(events.some((e) => e.e === 'rag:reindex-scheduled'), 'reindex-scheduled event emitted')
  t.ok(events.some((e) => e.e === 'rag:reindexed'), 'rag:reindexed event emitted')
  await rag.close()
})

test('scheduler is suppressed when CURVA_RAG_REINDEX_ENABLED=0', async (t) => {
  const prev = process.env.CURVA_RAG_REINDEX_ENABLED
  process.env.CURVA_RAG_REINDEX_ENABLED = '0'
  try {
    const sdk = makeFakeSdk()
    const rag = createRag({ sdkImpl: sdk, roomSlug: 'off' })
    await rag.ensureReady()
    const docs = Array.from({ length: REINDEX_INGEST_THRESHOLD + 10 }, (_, i) => 'd' + i)
    await rag.ingest(docs, { workspace: 'w' })
    await new Promise((r) => setTimeout(r, REINDEX_DEBOUNCE_MS + 100))
    t.is(sdk._peek.calls.ragReindex, 0, 'no reindex when flag off')
    await rag.close()
  } finally {
    if (prev === undefined) delete process.env.CURVA_RAG_REINDEX_ENABLED
    else process.env.CURVA_RAG_REINDEX_ENABLED = prev
  }
})

test('close() cancels pending reindex timers so no post-close reindex fires', async (t) => {
  const sdk = makeFakeSdk()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'cancel' })
  await rag.ensureReady()
  const docs = Array.from({ length: REINDEX_INGEST_THRESHOLD }, (_, i) => 'd' + i)
  await rag.ingest(docs, { workspace: 'w' })
  // Immediately close before debounce elapses.
  await rag.close()
  await new Promise((r) => setTimeout(r, REINDEX_DEBOUNCE_MS + 200))
  t.is(sdk._peek.calls.ragReindex, 0, 'no reindex after close()')
})
