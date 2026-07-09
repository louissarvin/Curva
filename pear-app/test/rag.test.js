// Semifinal QVAC depth: RAG grounding tests.
//
// Exercises bare/rag.js via injected fake @qvac/sdk (no real embed model). The
// fake mimics the ragIngest / ragSearch / embed / ragCloseWorkspace surface
// documented in pear-app/node_modules/@qvac/sdk/dist/client/api/rag.d.ts.

const test = require('brittle')
const { createRag, glossaryToDocuments, workspaceFor, MAX_DOC_BATCH } = require('../bare/rag.js')
const glossary = require('../bare/glossary.json')

// -- fake sdk --------------------------------------------------------------

function makeFakeSdk ({ failLoad = false, failIngest = false, dropSearch = false } = {}) {
  const workspaces = new Map() // ws -> Array<{id, content}>
  let modelSeq = 0
  const calls = { loadModel: 0, ragIngest: 0, ragSearch: 0, ragCloseWorkspace: 0, embed: 0, unloadModel: 0 }
  return {
    // Registry constant stub so the module's resolve-constant path is exercised.
    EMBEDDINGGEMMA_300M_Q4_0: { name: 'EMBEDDINGGEMMA_300M_Q4_0', url: 'stub://embed' },
    async loadModel ({ modelSrc, modelType }) {
      calls.loadModel++
      if (failLoad) throw new Error('load fail')
      if (!modelSrc || modelType !== 'embedding') throw new Error('bad load call')
      return 'embed-model-' + (++modelSeq)
    },
    async ragIngest ({ modelId, workspace, documents }) {
      calls.ragIngest++
      if (failIngest) throw new Error('ingest fail')
      if (!modelId || !workspace || !Array.isArray(documents)) throw new Error('bad ingest')
      const store = workspaces.get(workspace) || []
      const processed = []
      documents.forEach((d, i) => {
        const id = workspace + '#' + (store.length + i)
        store.push({ id, content: String(d) })
        processed.push({ id })
      })
      workspaces.set(workspace, store)
      return { processed, droppedIndices: [] }
    },
    async ragSearch ({ modelId, workspace, query, topK = 3 }) {
      calls.ragSearch++
      if (dropSearch) throw new Error('search fail')
      if (!modelId || !workspace) throw new Error('bad search')
      const store = workspaces.get(workspace) || []
      const q = String(query || '').toLowerCase()
      // Score by number of matching words (deterministic + trivial).
      const scored = store.map((row) => {
        const c = row.content.toLowerCase()
        let score = 0
        for (const term of q.split(/\s+/)) {
          if (term.length >= 2 && c.includes(term)) score += 1
        }
        return { ...row, score: score + Math.min(0.001 * store.indexOf(row), 0.01) }
      }).filter((r) => r.score > 0)
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, topK)
    },
    async embed ({ modelId, text }) {
      calls.embed++
      if (!modelId) throw new Error('bad embed')
      const one = (s) => Array.from({ length: 8 }, (_, i) => (String(s).length + i) % 7 / 7)
      return Array.isArray(text) ? { embedding: text.map(one) } : { embedding: one(text) }
    },
    async ragCloseWorkspace ({ workspace }) {
      calls.ragCloseWorkspace++
      workspaces.delete(workspace)
    },
    async unloadModel () { calls.unloadModel++ },
    _peek: { workspaces, calls }
  }
}

test('createRag loads embed model + reports status', async (t) => {
  const sdk = makeFakeSdk()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'demo' })
  t.absent(rag.status().ready, 'not ready before ensureReady')
  const ok = await rag.ensureReady()
  t.ok(ok, 'ensureReady resolves true')
  t.is(sdk._peek.calls.loadModel, 1, 'loadModel called once')
  t.ok(rag.status().modelId.startsWith('embed-model-'), 'modelId assigned')
})

test('ingest glossary + search returns top-1 relevant entry', async (t) => {
  const sdk = makeFakeSdk()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'italy-vs-france' })

  const docs = glossaryToDocuments(glossary, { limit: 200 })
  t.ok(docs.length > 40, 'glossary produced at least 40 documents')

  const res = await rag.ingest(docs, { kind: 'glossary' })
  t.ok(res.ok, 'ingest succeeded')
  t.is(res.workspace, workspaceFor('italy-vs-france', 'glossary'))
  t.ok(res.processed >= docs.length, 'processed count matches input')

  const hits = await rag.search('offside fuorigioco impedimento', { kind: 'glossary', topK: 3 })
  t.ok(hits.length > 0, 'search returns at least one hit')
  t.ok(/offside/i.test(hits[0].content), 'top hit mentions offside: ' + hits[0].content)
})

test('search merges multiple workspaces and picks by score', async (t) => {
  const sdk = makeFakeSdk()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'r2' })
  await rag.ingest(['football term "goal" (it:gol)'], { kind: 'glossary' })
  await rag.ingest(['alice: what a beautiful goal from Messi!'], { kind: 'chat' })
  const hits = await rag.search('goal', { topK: 5 })
  t.ok(hits.length >= 2, 'both workspaces contributed')
  const wsSet = new Set(hits.map((h) => h.workspace))
  t.ok(wsSet.has(workspaceFor('r2', 'glossary')), 'glossary workspace present')
  t.ok(wsSet.has(workspaceFor('r2', 'chat')), 'chat workspace present')
})

test('ingest caps batch at MAX_DOC_BATCH and does not crash on 100 docs', async (t) => {
  const sdk = makeFakeSdk()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'big' })
  const big = Array.from({ length: 100 }, (_, i) => 'doc number ' + i + ' about football')
  const res = await rag.ingest(big, { kind: 'chat' })
  t.ok(res.ok, 'ingest of 100 docs ok')
  t.is(res.processed, 100, '100 docs processed')
  // A 500 doc batch should be capped at MAX_DOC_BATCH.
  const huge = Array.from({ length: 500 }, (_, i) => 'x ' + i)
  const res2 = await rag.ingest(huge, { kind: 'chat' })
  t.ok(res2.ok, 'huge batch still succeeds')
  t.is(res2.processed, MAX_DOC_BATCH, 'huge batch capped')
})

test('sdk unavailable degrades gracefully', async (t) => {
  const rag = createRag({ sdkImpl: {}, roomSlug: 'x' })
  const events = []
  rag._internal.state // touch to ensure module loaded
  const ok = await rag.ensureReady()
  t.absent(ok, 'ensureReady returns false when SDK missing rag surface')
  const hits = await rag.search('test')
  t.is(hits.length, 0, 'search returns [] when not ready')
  const ingested = await rag.ingest(['whatever'])
  t.absent(ingested.ok, 'ingest fails cleanly')
})

test('close tears down workspaces and unloads model', async (t) => {
  const sdk = makeFakeSdk()
  const rag = createRag({ sdkImpl: sdk, roomSlug: 'r3' })
  await rag.ingest(['a'], { kind: 'glossary' })
  await rag.ingest(['b'], { kind: 'chat' })
  await rag.close()
  t.is(sdk._peek.calls.ragCloseWorkspace, 2, 'both workspaces closed')
  t.is(sdk._peek.calls.unloadModel, 1, 'embed model unloaded')
  t.absent(rag.status().ready, 'ready flag cleared')
})

test('workspaceFor deterministic slug + limits length', (t) => {
  t.is(workspaceFor('Team FR vs IT!', 'glossary'), 'curva/room/team-fr-vs-it/glossary')
  t.is(workspaceFor('  ', 'chat'), 'curva/room/default/chat')
})
