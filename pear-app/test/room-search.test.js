// F6 room-search brittle tests.
//
// Exercises bare/roomSearch.js via an injected fake sdk (no real embed model).
// The fake mirrors the @qvac/sdk surface used by roomSearch:
//   - loadModel({modelSrc, modelType}) -> Promise<string>
//   - ragIngest({modelId, workspace, documents, chunk}) -> Promise<{processed,droppedIndices}>
//   - ragSearch({modelId, workspace, query, topK}) -> Promise<Array<{id,content,score}>>
//   - ragCloseWorkspace({workspace}) -> Promise<void>
// Verified against pear-app/node_modules/@qvac/sdk/dist/client/api/rag.d.ts.

const test = require('brittle')
const {
  createRoomSearch,
  workspaceForRoom,
  sanitizeText,
  simpleChunk
} = require('../bare/roomSearch.js')

function makeFakeSdk () {
  const calls = { loadModel: 0, ragIngest: 0, ragSearch: 0, ragCloseWorkspace: 0 }
  const workspaces = new Map() // ws -> Array<{id, content}> (we track by insertion for test)
  const ingestedDocs = [] // last ingest doc list, cumulative
  let modelSeq = 0
  return {
    EMBEDDINGGEMMA_300M_Q4_0: { name: 'stub-embed' },
    async loadModel ({ modelSrc, modelType }) {
      calls.loadModel += 1
      if (!modelSrc || modelType !== 'embedding') throw new Error('bad load')
      return 'embed-model-' + (++modelSeq)
    },
    async ragIngest ({ modelId, workspace, documents }) {
      calls.ragIngest += 1
      if (!modelId || !workspace) throw new Error('bad ingest')
      if (!Array.isArray(documents)) throw new Error('bad docs')
      const store = workspaces.get(workspace) || []
      const processed = []
      for (const d of documents) {
        const id = workspace + '#' + store.length
        store.push({ id, content: String(d) })
        ingestedDocs.push({ workspace, content: String(d), id })
        processed.push({ id })
      }
      workspaces.set(workspace, store)
      return { processed, droppedIndices: [] }
    },
    async ragSearch ({ modelId, workspace, query, topK = 3 }) {
      calls.ragSearch += 1
      if (!modelId || !workspace) throw new Error('bad search')
      const store = workspaces.get(workspace) || []
      const q = String(query || '').toLowerCase()
      const scored = []
      for (const row of store) {
        let s = 0
        for (const term of q.split(/\s+/)) {
          if (term.length >= 2 && row.content.toLowerCase().includes(term)) s += 1
        }
        if (s > 0) scored.push({ ...row, score: s })
      }
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, topK)
    },
    async ragCloseWorkspace ({ workspace }) {
      calls.ragCloseWorkspace += 1
      workspaces.delete(workspace)
    },
    _peek: { calls, workspaces, ingestedDocs }
  }
}

function makeFakeChat (rows = []) {
  const listeners = new Set()
  return {
    _rows: rows,
    _listeners: listeners,
    async history ({ from = 0, limit = 100 } = {}) {
      return rows.slice(0, Math.min(limit, rows.length))
    },
    onMessage (cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    _emit (msg) {
      for (const cb of listeners) cb(msg)
    }
  }
}

// ---- workspace naming ------------------------------------------------------

test('F6: workspaceForRoom is per-room and stable', (t) => {
  const a = workspaceForRoom('demo-room')
  const b = workspaceForRoom('demo-room')
  const c = workspaceForRoom('another-room')
  t.is(a, b, 'same slug -> same workspace')
  t.not(a, c, 'different slug -> different workspace')
  t.ok(a.startsWith('curva-room-search-'), 'has expected prefix')
  t.is(a.length, 'curva-room-search-'.length + 16, 'hash truncated to 16 hex')
})

// ---- sanitize ---------------------------------------------------------------

test('F6: sanitizeText applies NFKC + strips control chars', (t) => {
  // NFKC: fullwidth 'Ａ' -> 'A'; ligature 'ﬁ' -> 'fi'.
  const s1 = sanitizeText('Ａgoalﬁre')
  t.is(s1, 'Agoalfire', 'NFKC width + ligature collapsed')
  const s2 = sanitizeText('hello\x00world\x1b[31mred')
  t.is(s2, 'helloworld[31mred', 'control chars stripped')
  const s3 = sanitizeText('  a\tb\nc  d ')
  t.is(s3, 'a b c d', 'tabs/newlines collapse to single spaces + trim')
  t.is(sanitizeText(null), '')
  t.is(sanitizeText(''), '')
})

// ---- ingestMessage ---------------------------------------------------------

test('F6: ingestMessage chunks + ingests each new message once', async (t) => {
  const sdk = makeFakeSdk()
  const chat = makeFakeChat([])
  const rs = createRoomSearch({ sdk, chat, roomSlug: 'demo' })

  const res1 = await rs.ingestMessage({
    id: '1700000000000-aabbccdd',
    author: 'aabbccdd',
    text: 'jamal thinks the penalty call was too soft',
    at: 1700000000000
  })
  t.ok(res1.ok, 'first ingest ok')
  t.ok(res1.ingested >= 1, 'at least one chunk landed')
  t.is(sdk._peek.calls.loadModel, 1, 'loadModel called once on first use')
  t.is(sdk._peek.calls.ragIngest, 1, 'ragIngest called once')

  // Second call to the SAME msg id must be a no-op (dedupe by chunk id).
  const res2 = await rs.ingestMessage({
    id: '1700000000000-aabbccdd',
    author: 'aabbccdd',
    text: 'jamal thinks the penalty call was too soft',
    at: 1700000000000
  })
  t.ok(res2.ok, 'duplicate ingest still resolves ok')
  t.is(res2.ingested, 0, 'zero new chunks landed on replay')
  t.is(sdk._peek.calls.ragIngest, 1, 'ragIngest NOT called again')
})

test('F6: ingestMessage rejects empty text and empty id', async (t) => {
  const sdk = makeFakeSdk()
  const rs = createRoomSearch({ sdk, chat: makeFakeChat([]), roomSlug: 'demo' })
  const r1 = await rs.ingestMessage({ id: 'a', text: '' })
  t.absent(r1.ok, 'empty text rejected')
  t.is(r1.reason, 'EMPTY_TEXT')
  const r2 = await rs.ingestMessage({ id: '', text: 'hi' })
  t.absent(r2.ok, 'empty id rejected')
  t.is(r2.reason, 'EMPTY_ID')
})

// ---- prompt-injection defense on ingest -----------------------------------

test('F6: NFKC + control-strip applied to text before ingest', async (t) => {
  const sdk = makeFakeSdk()
  const rs = createRoomSearch({ sdk, chat: makeFakeChat([]), roomSlug: 'demo' })
  // Feed something with a nasty control char + fullwidth chars.
  await rs.ingestMessage({
    id: 'ctrl-1',
    author: 'x',
    text: 'Ｇoal\x00 by \x1bJamal',
    at: 1
  })
  const ingested = sdk._peek.ingestedDocs
  t.ok(ingested.length >= 1, 'ingested at least one doc')
  const combined = ingested.map((d) => d.content).join(' | ')
  t.absent(combined.includes('\x00'), 'no NULL byte survived')
  t.absent(combined.includes('\x1b'), 'no ESC byte survived')
  t.ok(combined.includes('Goal'), 'NFKC folded the fullwidth G')
})

// ---- reindexAll ------------------------------------------------------------

test('F6: reindexAll pulls history + ingests all msg rows', async (t) => {
  const sdk = makeFakeSdk()
  const rows = [
    { type: 'msg', text: 'hello world', by_peer: 'aabbccdd', wall_clock_ms: 100 },
    { type: 'msg', text: 'penalty on jamal', by_peer: 'eeff0011', wall_clock_ms: 200 },
    { type: 'system:tip', text: 'unrelated', by_peer: 'x', wall_clock_ms: 300 },
    { type: 'msg', text: 'goal in the 90th minute!', by_peer: 'aabbccdd', wall_clock_ms: 400 }
  ]
  const chat = makeFakeChat(rows)
  const rs = createRoomSearch({ sdk, chat, roomSlug: 'reindex-room' })

  const res = await rs.reindexAll()
  t.ok(res.ok, 'reindex ok')
  t.is(res.total, 4, 'saw all 4 rows')
  t.is(res.skipped, 1, 'skipped the one system row')
  t.ok(res.processed >= 3, 'processed at least the three msg rows')
  t.is(sdk._peek.calls.ragIngest, 3, 'ragIngest called once per msg row')
})

// ---- search shape ----------------------------------------------------------

test('F6: search returns properly shaped results sorted by score', async (t) => {
  const sdk = makeFakeSdk()
  const chat = makeFakeChat([])
  const rs = createRoomSearch({ sdk, chat, roomSlug: 'search-room' })
  await rs.ingestMessage({ id: '100-aaaa', author: 'aaaa', text: 'penalty on jamal in the box', at: 100 })
  await rs.ingestMessage({ id: '200-bbbb', author: 'bbbb', text: 'ronaldo header from a corner', at: 200 })
  await rs.ingestMessage({ id: '300-cccc', author: 'cccc', text: 'jamal took the penalty and scored', at: 300 })

  const hits = await rs.search({ query: 'jamal penalty', k: 5 })
  t.ok(Array.isArray(hits), 'array of hits')
  t.ok(hits.length >= 2, 'at least two hits')
  for (const h of hits) {
    t.is(typeof h.msgId, 'string', 'msgId string')
    t.is(typeof h.author, 'string', 'author string')
    t.ok(typeof h.at === 'number' || h.at === null, 'at number or null')
    t.is(typeof h.snippet, 'string', 'snippet string')
    t.is(typeof h.score, 'number', 'score number')
    t.ok(h.snippet.length <= 240, 'snippet capped')
  }
  // Highest-scoring hit must include the query terms.
  const top = hits[0]
  t.ok(/jamal/i.test(top.snippet) || /penalty/i.test(top.snippet), 'top hit matches query')
})

test('F6: search sanitizes query input', async (t) => {
  const sdk = makeFakeSdk()
  const chat = makeFakeChat([])
  const rs = createRoomSearch({ sdk, chat, roomSlug: 'sanitize-room' })
  await rs.ingestMessage({ id: '1-aaaa', author: 'aaaa', text: 'jamal goal', at: 1 })
  // Query with NUL/ESC chars — should still land the hit.
  const hits = await rs.search({ query: 'jamal\x00 goal\x1b', k: 5 })
  t.ok(hits.length >= 1, 'query sanitized + still returned a hit')
})

test('F6: search returns [] for empty query', async (t) => {
  const sdk = makeFakeSdk()
  const rs = createRoomSearch({ sdk, chat: makeFakeChat([]), roomSlug: 'empty' })
  const hits = await rs.search({ query: '' })
  t.is(hits.length, 0, 'empty query -> no hits')
  const hits2 = await rs.search({ query: '   \x00\x1b' })
  t.is(hits2.length, 0, 'query that sanitizes to empty -> no hits')
})

// ---- debounce --------------------------------------------------------------

test('F6: 3 rapid ingestMessage calls do NOT trigger 3 reindex passes', async (t) => {
  const sdk = makeFakeSdk()
  const chat = makeFakeChat([
    { type: 'msg', text: 'first', by_peer: 'aa', wall_clock_ms: 1 }
  ])
  const rs = createRoomSearch({ sdk, chat, roomSlug: 'debounce' })

  // Prime + schedule multiple reindexes rapid-fire.
  rs.scheduleDebouncedReindex()
  rs.scheduleDebouncedReindex()
  rs.scheduleDebouncedReindex()
  // Only one timer is armed at a time (subsequent scheduleDebouncedReindex
  // calls short-circuit while a timer exists).
  const st = rs.status()
  t.ok(st.enabled, 'enabled')

  // We CANNOT wait 15s in a unit test. Verify the internal timer is a single
  // timer (state.reindexTimer set once).
  t.ok(rs._internal.state.reindexTimer, 'timer armed after first schedule')
  // Second/third schedule must NOT arm another timer.
  const armed = rs._internal.state.reindexTimer
  rs.scheduleDebouncedReindex()
  t.is(rs._internal.state.reindexTimer, armed, 'timer still the SAME after re-schedule')

  // Cleanup so brittle does not hang on the outstanding timer.
  await rs.close()
})

// ---- close persists (deleteOnClose = false) --------------------------------

test('F6: close() calls ragCloseWorkspace WITHOUT deleteOnClose', async (t) => {
  const sdk = makeFakeSdk()
  // Wrap ragCloseWorkspace to capture args.
  const origClose = sdk.ragCloseWorkspace.bind(sdk)
  let closeArgs = null
  sdk.ragCloseWorkspace = async (opts) => {
    closeArgs = opts
    return origClose(opts)
  }
  const rs = createRoomSearch({ sdk, chat: makeFakeChat([]), roomSlug: 'persist' })
  await rs.ingestMessage({ id: '1-aa', text: 'hello', author: 'aa', at: 1 })
  await rs.close()
  t.ok(closeArgs, 'ragCloseWorkspace was invoked')
  t.absent(closeArgs.deleteOnClose, 'deleteOnClose NOT set — workspace persists across boots')
  t.ok(typeof closeArgs.workspace === 'string' && closeArgs.workspace.startsWith('curva-room-search-'),
    'per-room workspace name passed')
})

// ---- feature flag off ------------------------------------------------------

test('F6: search returns [] when SDK is missing', async (t) => {
  const rs = createRoomSearch({ sdk: null, chat: makeFakeChat([]), roomSlug: 'nosdk' })
  const hits = await rs.search({ query: 'anything' })
  t.is(hits.length, 0, 'no sdk -> empty results')
  const r = await rs.ingestMessage({ id: '1-a', text: 'x', author: 'a' })
  t.absent(r.ok, 'ingest fails without sdk')
})

// ---- simpleChunk unit ------------------------------------------------------

test('F6: simpleChunk respects size + overlap', (t) => {
  const chunks = simpleChunk('a'.repeat(500), 200, 20)
  t.ok(chunks.length >= 2, 'produced multiple chunks')
  for (const c of chunks) t.ok(c.length <= 200, 'chunk <= size')
  t.is(simpleChunk('', 200, 20).length, 0, 'empty -> no chunks')
  t.is(simpleChunk('short', 200, 20).length, 1, 'short -> single chunk')
})
