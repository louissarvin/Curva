// Wave 3 F3 brittle tests: semantic clip search via embed().
//
// Fake @qvac/sdk deterministically maps text -> vector so cosine rankings are
// reproducible. Tests cover indexing, cosine ranking, LRU eviction on cap,
// snapshot/restore round-trip, removal, and graceful failure modes.

const test = require('brittle')
const {
  createSemanticSearch,
  cosine,
  sanitizeText,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TOP_K,
  MAX_TOP_K,
  MAX_TEXT_CHARS,
  MAX_QUERY_CHARS
} = require('../bare/semanticSearch.js')

// -- Docs-verification memo -------------------------------------------------

test('docs-verification memo lives at the top of semanticSearch.js', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'bare', 'semanticSearch.js'), 'utf8')
  const head = src.slice(0, 3000)
  t.ok(head.includes('Docs-verification memo'), 'memo present')
  t.ok(head.includes('embed.d.ts'), 'cites embed.d.ts')
  t.ok(head.includes('text-embeddings'), 'cites embeddings docs URL')
})

// -- Helpers ----------------------------------------------------------------

/**
 * Deterministic embedding: pick a handful of keyword tokens and one-hot them.
 * Query and document must share at least one keyword to have positive cosine.
 * Guaranteed same-length vectors so cosine math is well-defined.
 */
const KEYWORDS = ['ronaldo', 'header', 'penalty', 'save', 'goal', 'winger', 'offside', 'foul']

function vecFor (text) {
  const v = new Array(KEYWORDS.length).fill(0)
  const s = String(text || '').toLowerCase()
  for (let i = 0; i < KEYWORDS.length; i++) {
    if (s.includes(KEYWORDS[i])) v[i] = 1
  }
  // Add a tiny epsilon so a zero-hit text still has non-zero norm and cosine
  // returns something small but comparable. Prevents divide-by-zero paths
  // hiding real bugs.
  v.push(0.0001)
  return v
}

function fakeSdk ({ failLoad = false, embedThrows = null } = {}) {
  const calls = { loadModel: 0, embed: 0, unloadModel: 0 }
  return {
    _calls: calls,
    EMBEDDINGGEMMA_300M_Q4_0: { name: 'EMBEDDINGGEMMA_300M_Q4_0', url: 'stub://' },
    async loadModel ({ modelSrc, modelType }) {
      calls.loadModel += 1
      if (failLoad) throw new Error('load fail')
      if (modelType !== 'embedding') throw new Error('bad modelType')
      return 'embed-model-1'
    },
    async embed ({ modelId, text }) {
      calls.embed += 1
      if (embedThrows) throw embedThrows
      if (!modelId) throw new Error('missing modelId')
      if (Array.isArray(text)) return { embedding: text.map(vecFor) }
      return { embedding: vecFor(text) }
    },
    async unloadModel () { calls.unloadModel += 1 }
  }
}

function collectEmits () {
  const events = []
  const emit = (e, p) => events.push({ e, p })
  return { events, emit }
}

// -- cosine + sanitize -----------------------------------------------------

test('cosine handles orthogonal + parallel + zero vectors', (t) => {
  t.is(cosine([1, 0, 0], [1, 0, 0]), 1, 'parallel = 1')
  t.is(cosine([1, 0, 0], [0, 1, 0]), 0, 'orthogonal = 0')
  t.is(cosine([0, 0, 0], [1, 1, 1]), 0, 'zero vector = 0 (no NaN)')
})

test('cosine returns 0 on invalid input', (t) => {
  t.is(cosine(null, [1]), 0)
  t.is(cosine([1], null), 0)
  t.is(cosine('str', [1]), 0)
})

test('sanitizeText strips control chars and caps length', (t) => {
  t.is(sanitizeText('a\x00b\x01c', 100), 'a b c')
  t.is(sanitizeText('x'.repeat(1000), 100).length, 100)
  t.is(sanitizeText(null, 100), '')
})

// -- Basic index / search --------------------------------------------------

test('index() lazy-loads embed model then stores a vector', async (t) => {
  const sdk = fakeSdk()
  const s = createSemanticSearch({ sdk })
  const res = await s.index('clip-1', 'A Ronaldo header cracks the crossbar.')
  t.ok(res.ok)
  t.is(sdk._calls.loadModel, 1, 'loadModel called once (lazy)')
  t.is(sdk._calls.embed, 1)
  t.is(res.dims, KEYWORDS.length + 1)
})

test('search() ranks entries by cosine descending', async (t) => {
  const sdk = fakeSdk()
  const s = createSemanticSearch({ sdk })
  await s.index('clip-1', 'A ronaldo header at the back post.')
  await s.index('clip-2', 'A goalkeeper save on a penalty.')
  await s.index('clip-3', 'A tactical foul on the winger.')
  const hits = await s.search('that ronaldo header', { topK: 3 })
  t.is(hits.length, 3, 'got 3 results')
  t.is(hits[0].id, 'clip-1', 'ronaldo+header ranks first')
  t.ok(hits[0].score > hits[1].score, 'strict descending order')
  t.ok(hits[1].score >= hits[2].score, 'still descending on lower hits')
})

test('search() honors topK bound', async (t) => {
  const sdk = fakeSdk()
  const s = createSemanticSearch({ sdk })
  for (let i = 0; i < 5; i++) {
    await s.index('clip-' + i, 'ronaldo scored goal ' + i)
  }
  const hits = await s.search('ronaldo goal', { topK: 2 })
  t.is(hits.length, 2)
})

test('search() clamps oversized topK to MAX_TOP_K', async (t) => {
  const sdk = fakeSdk()
  const s = createSemanticSearch({ sdk })
  await s.index('a', 'header')
  const hits = await s.search('header', { topK: 999 })
  t.ok(hits.length <= MAX_TOP_K)
})

test('search() returns [] on empty index', async (t) => {
  const sdk = fakeSdk()
  const s = createSemanticSearch({ sdk })
  const hits = await s.search('anything')
  t.is(hits.length, 0)
  t.is(sdk._calls.embed, 0, 'no query embed when index empty')
})

test('search() returns [] on empty query', async (t) => {
  const sdk = fakeSdk()
  const s = createSemanticSearch({ sdk })
  await s.index('a', 'header')
  t.is((await s.search('')).length, 0)
  t.is((await s.search('   ')).length, 0)
  t.is((await s.search(null)).length, 0)
})

test('deterministic tie-break: equal scores fall back to insertion order', async (t) => {
  const sdk = fakeSdk()
  const s = createSemanticSearch({ sdk })
  await s.index('first', 'ronaldo goal')
  await s.index('second', 'ronaldo goal') // identical content -> equal score
  await s.index('third', 'ronaldo goal')
  const hits = await s.search('ronaldo goal', { topK: 3 })
  t.is(hits[0].id, 'first', 'oldest wins tie')
  t.is(hits[1].id, 'second')
  t.is(hits[2].id, 'third')
})

// -- LRU eviction -----------------------------------------------------------

test('index() evicts least-recently-touched when over cap', async (t) => {
  const sdk = fakeSdk()
  const { events, emit } = collectEmits()
  const s = createSemanticSearch({ sdk, maxEntries: 3, emit })
  await s.index('a', 'ronaldo')
  await s.index('b', 'header')
  await s.index('c', 'penalty')
  // Touch 'a' by searching for ronaldo (search touches all returned entries).
  await s.search('ronaldo', { topK: 1 })
  // Now insert a fourth entry; 'b' should be the LRU victim ('a' was touched
  // by search, 'c' by its own insert).
  await s.index('d', 'winger')
  const status = s.status()
  t.is(status.size, 3, 'still at cap after insert')
  const evicted = events.filter((e) => e.e === 'semsearch:evicted').map((e) => e.p.id)
  t.is(evicted.length, 1, 'exactly one eviction')
  t.is(evicted[0], 'b', "'b' was the LRU victim")
})

test('index() replacing an existing id does not trigger eviction', async (t) => {
  const sdk = fakeSdk()
  const s = createSemanticSearch({ sdk, maxEntries: 2 })
  await s.index('a', 'ronaldo')
  await s.index('b', 'header')
  // Replace 'a' - size is still 2, no eviction.
  await s.index('a', 'ronaldo updated')
  t.is(s.status().size, 2)
})

// -- remove -----------------------------------------------------------------

test('remove() drops entry by id + is idempotent', async (t) => {
  const sdk = fakeSdk()
  const s = createSemanticSearch({ sdk })
  await s.index('a', 'ronaldo')
  const r1 = s.remove('a')
  t.ok(r1.ok)
  t.ok(r1.removed)
  const r2 = s.remove('a')
  t.ok(r2.ok, 'idempotent ok')
  t.absent(r2.removed, 'not removed second time')
})

test('remove() rejects bad id', (t) => {
  const s = createSemanticSearch({ sdk: fakeSdk() })
  const r = s.remove(null)
  t.absent(r.ok)
  t.is(r.code, 'BAD_ID')
})

// -- snapshot / restore ----------------------------------------------------

test('snapshot() then restore() round-trips vectors + text', async (t) => {
  const sdk = fakeSdk()
  const s = createSemanticSearch({ sdk })
  await s.index('a', 'ronaldo header')
  await s.index('b', 'penalty save')
  const snap = s.snapshot()
  t.is(snap.size, 2)
  t.is(snap.entries.length, 2)
  t.ok(Array.isArray(snap.entries[0].vec))

  const s2 = createSemanticSearch({ sdk: fakeSdk() })
  const r = s2.restore(snap)
  t.ok(r.ok)
  t.is(r.size, 2)
  // Search on the rehydrated instance does NOT need to re-embed the docs; only
  // the query needs an embed call. Confirm the ranking is preserved.
  const hits = await s2.search('ronaldo', { topK: 2 })
  t.is(hits[0].id, 'a')
})

test('restore() rejects bad snapshot', (t) => {
  const s = createSemanticSearch({ sdk: fakeSdk() })
  const r = s.restore(null)
  t.absent(r.ok)
})

// -- Validation guards ------------------------------------------------------

test('index() rejects bad id + empty text', async (t) => {
  const s = createSemanticSearch({ sdk: fakeSdk() })
  const r1 = await s.index('', 'text')
  t.is(r1.code, 'BAD_ID')
  const r2 = await s.index('id', '')
  t.is(r2.code, 'EMPTY_TEXT')
  const r3 = await s.index('id', '   \x00\x01  ')
  t.is(r3.code, 'EMPTY_TEXT', 'sanitize-to-empty rejected')
})

test('index() rejects id longer than 128 chars', async (t) => {
  const s = createSemanticSearch({ sdk: fakeSdk() })
  const r = await s.index('x'.repeat(129), 'text')
  t.is(r.code, 'ID_TOO_LONG')
})

test('MAX_TEXT_CHARS + MAX_QUERY_CHARS are enforced by sanitizer', (t) => {
  t.is(sanitizeText('x'.repeat(MAX_TEXT_CHARS + 500), MAX_TEXT_CHARS).length, MAX_TEXT_CHARS)
  t.is(sanitizeText('y'.repeat(MAX_QUERY_CHARS + 500), MAX_QUERY_CHARS).length, MAX_QUERY_CHARS)
})

// -- Failure paths ---------------------------------------------------------

test('index() reports NOT_READY when load fails', async (t) => {
  const s = createSemanticSearch({ sdk: fakeSdk({ failLoad: true }) })
  const r = await s.index('a', 'text')
  t.absent(r.ok)
  t.is(r.code, 'NOT_READY')
})

test('index() reports EMBED_FAILED when embed throws', async (t) => {
  const s = createSemanticSearch({ sdk: fakeSdk({ embedThrows: new Error('gpu oom') }) })
  const r = await s.index('a', 'text')
  t.absent(r.ok)
  t.is(r.code, 'EMBED_FAILED')
})

test('search() returns [] when embed throws mid-search', async (t) => {
  const sdk = fakeSdk()
  const s = createSemanticSearch({ sdk })
  await s.index('a', 'ronaldo')
  // Swap embed to throw on the NEXT call.
  sdk.embed = async () => { throw new Error('query embed failed') }
  const hits = await s.search('ronaldo')
  t.is(hits.length, 0)
})

// -- close ------------------------------------------------------------------

test('close() clears entries and calls unloadModel', async (t) => {
  const sdk = fakeSdk()
  const s = createSemanticSearch({ sdk })
  await s.index('a', 'ronaldo')
  await s.close()
  t.is(sdk._calls.unloadModel, 1)
  t.ok(s.status().closed)
  const r = await s.index('b', 'text')
  t.absent(r.ok)
  t.is(r.code, 'CLOSED')
})

// -- Defaults exported ------------------------------------------------------

test('module defaults exported', (t) => {
  t.is(DEFAULT_MAX_ENTRIES, 1024)
  t.is(DEFAULT_TOP_K, 5)
  t.ok(MAX_TOP_K > 0)
  t.ok(MAX_TEXT_CHARS > 0)
  t.ok(MAX_QUERY_CHARS > 0)
})
