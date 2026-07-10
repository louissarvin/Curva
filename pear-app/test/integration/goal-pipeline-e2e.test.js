// Wave-final QVAC polish (F3) integration test: goal-pipeline end-to-end.
//
// Exercises the FULL fanout OCR -> goalCard -> MCP -> translate -> announcer
// -> chat.sendSystem in one trigger. Confirms:
//   - 6 capabilities fire in the correct order
//   - NO_CHANGE guard skips pipeline when the extracted score matches the
//     caller-supplied `currentScore`
//   - Bergamot fanout runs per locale independently (each locale gets its own
//     translate + speak call)
//   - Missing MCP AND missing translate are non-fatal; only OCR + goalCard
//     are required

const test = require('brittle')
const { createGoalPipeline, DEFAULT_LOCALES } = require('../../bare/goalPipeline.js')

// -- Fakes -----------------------------------------------------------------

function makeOcr (blocks) {
  return {
    calls: 0,
    async read () { this.calls += 1; return { ok: true, blocks, durationMs: 5 } }
  }
}

function makeGoalCard (card, opts = {}) {
  const { ok = true, delayMs = 0 } = opts
  return {
    calls: 0,
    async parse (text) {
      this.calls += 1
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      return ok ? { ok: true, card } : { ok: false, reason: 'invalid' }
    }
  }
}

function makeMcp () {
  const calls = []
  return {
    calls,
    async invokeTool (name, payload) {
      calls.push({ name, payload })
      return { ok: true, name }
    }
  }
}

function makeTranslate () {
  const calls = []
  return {
    calls,
    async translate ({ text, from, to }) {
      calls.push({ text, from, to })
      return '[' + to + '] ' + text
    }
  }
}

function makeAnnouncer (events) {
  return {
    calls: [],
    async openSpeakStream ({ locale }) {
      this.calls.push(locale)
      const session = {
        written: [],
        write (t) { this.written.push(t) },
        end () { events.push({ type: 'session-end', locale }) },
        destroy () {},
        chunks: (async function * () {
          yield { buffer: [1, 2], chunkIndex: 0, done: false }
          yield { buffer: [3, 4], chunkIndex: 1, done: true }
        })()
      }
      events.push({ type: 'session-open', locale })
      return session
    }
  }
}

function makeChat () {
  const sent = []
  return {
    sent,
    async sendSystem (msg) { sent.push(msg) }
  }
}

// -- Enable feature flag for the pipeline (or use flagOverride) -----------

function pipelineWithFlag (deps) {
  return createGoalPipeline({ ...deps, flagOverride: true })
}

// ---------------------------------------------------------------------------

test('e2e: full pipeline fires 6 capabilities in the correct order', async (t) => {
  const timeline = []
  const emit = (name, payload) => timeline.push({ type: 'emit', name, payload })

  const blocks = [
    { text: 'ITA 1', confidence: 0.9 },
    { text: 'FRA 0', confidence: 0.9 },
    { text: "45'", confidence: 0.8 }
  ]
  const ocr = makeOcr(blocks)
  const goalCard = makeGoalCard({
    minute: 45,
    scorer: 'Buffon',
    team: 'Italy',
    assist: 'Pirlo'
  })
  const mcp = makeMcp()
  const translate = makeTranslate()
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const chat = makeChat()

  const pipeline = pipelineWithFlag({
    ocr, goalCard, mcp, translate, announcer, chat,
    roomSlug: 'demo-goal',
    locales: ['en', 'it', 'id'],
    emit
  })

  const res = await pipeline.trigger({
    image: 'stub-buf',
    currentScore: { home: 0, away: 0 }
  })

  t.ok(res.ok, 'trigger returned ok')
  t.is(res.card.scorer, 'Buffon', 'card scorer propagated')
  t.is(ocr.calls, 1, 'OCR called once')
  t.is(goalCard.calls, 1, 'goalCard called once')
  t.is(mcp.calls.length, 1, 'MCP invokeTool called once')
  t.is(mcp.calls[0].name, 'updateMatchState', 'MCP tool name matches')

  // Bergamot fanout: 2 translations (it, id) — 'en' is source
  t.is(translate.calls.length, 2, 'translate called twice (it, id)')
  const langs = translate.calls.map((c) => c.to).sort()
  t.alike(langs, ['id', 'it'], 'translate targets it + id')

  // Announcer: 3 speak sessions total
  t.is(announcer.calls.length, 3, 'announcer opened 3 sessions')
  t.alike(announcer.calls.sort(), ['en', 'id', 'it'], 'one per locale')

  // Chat append at the end
  t.is(chat.sent.length, 1, 'chat.sendSystem called once')
  t.is(chat.sent[0].type, 'system:goal-card', 'system:goal-card message')

  // Emit ordering: ocr -> parsed -> mcp -> translated -> speak-open -> speak-end -> chat-append
  const emitNames = timeline.filter((e) => e.type === 'emit').map((e) => e.name)
  const iOcr = emitNames.indexOf('goalpipe:ocr')
  const iParsed = emitNames.indexOf('goalpipe:parsed')
  const iMcp = emitNames.indexOf('goalpipe:mcp')
  const iChat = emitNames.indexOf('goalpipe:chat-append')
  t.ok(iOcr >= 0 && iOcr < iParsed, 'ocr before parsed')
  t.ok(iParsed < iMcp, 'parsed before mcp')
  t.ok(iMcp < iChat, 'mcp before chat-append')
})

test('e2e: NO_CHANGE guard skips pipeline when score unchanged', async (t) => {
  const emit = () => {}
  const blocks = [
    { text: 'ITA 1 - 0 FRA', confidence: 0.9 }
  ]
  const ocr = makeOcr(blocks)
  const goalCard = makeGoalCard({ minute: 20, scorer: 'x', team: 'y', assist: null })
  const mcp = makeMcp()
  const chat = makeChat()

  const pipeline = pipelineWithFlag({
    ocr, goalCard, mcp, chat,
    roomSlug: 'r', emit
  })

  // ocr extracts { home: 1, away: 0 } — same as currentScore -> NO_CHANGE
  const res = await pipeline.trigger({
    image: 'stub',
    currentScore: { home: 1, away: 0 }
  })
  t.absent(res.ok, 'no-change skips')
  t.is(res.reason, 'NO_CHANGE', 'reason=NO_CHANGE')
  t.is(goalCard.calls, 0, 'goalCard NOT invoked when unchanged')
  t.is(mcp.calls.length, 0, 'MCP NOT invoked')
  t.is(chat.sent.length, 0, 'chat NOT appended')
})

test('e2e: Bergamot fanout runs per locale independently — one failure does NOT block others', async (t) => {
  const emit = () => {}
  const blocks = [
    { text: 'ITA 2 - 1 FRA', confidence: 0.9 }
  ]
  const ocr = makeOcr(blocks)
  const goalCard = makeGoalCard({ minute: 60, scorer: 'Del Piero', team: 'Italy', assist: null })

  // Translator: throw on 'it' but succeed on 'id'
  const flakyTranslate = {
    calls: [],
    async translate ({ text, from, to }) {
      this.calls.push({ to })
      if (to === 'it') throw new Error('bergamot pair missing')
      return '[' + to + '] ' + text
    }
  }
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const chat = makeChat()

  const pipeline = pipelineWithFlag({
    ocr, goalCard, translate: flakyTranslate, announcer, chat,
    locales: ['en', 'it', 'id'], emit,
    roomSlug: 'flaky'
  })
  const res = await pipeline.trigger({
    image: 'stub',
    currentScore: { home: 1, away: 1 }
  })
  t.ok(res.ok, 'pipeline still succeeded overall')
  // Even with 'it' translation failing, all 3 locales get spoken (en source,
  // it falls back to English, id gets translated).
  t.is(announcer.calls.length, 3, 'all 3 locales still got a speak session')
  t.is(chat.sent.length, 1, 'chat appended once')
})

test('e2e: missing MCP + missing translate are non-fatal', async (t) => {
  const emit = () => {}
  const blocks = [
    { text: 'ITA 3 - 1 FRA', confidence: 0.9 }
  ]
  const ocr = makeOcr(blocks)
  const goalCard = makeGoalCard({ minute: 75, scorer: 'Vieri', team: 'Italy', assist: null })
  const announcerEvents = []
  const announcer = makeAnnouncer(announcerEvents)
  const chat = makeChat()
  // No MCP, no translate.
  const pipeline = pipelineWithFlag({
    ocr, goalCard, announcer, chat,
    locales: ['en', 'it'], emit,
    roomSlug: 'minimal'
  })
  const res = await pipeline.trigger({
    image: 'stub',
    currentScore: { home: 2, away: 1 }
  })
  t.ok(res.ok, 'pipeline succeeded without MCP + translate')
  t.absent(res.mcp.ok, 'mcp.ok false')
  t.is(res.mcp.reason, 'NO_MCP', 'reason=NO_MCP')
  t.is(announcer.calls.length, 2, 'both locales still got a speak session (English fallback)')
  t.is(chat.sent.length, 1, 'chat appended once')
})

test('e2e: DEFAULT_LOCALES matches spec (en, it, id)', async (t) => {
  t.alike(DEFAULT_LOCALES, ['en', 'it', 'id'], 'DEFAULT_LOCALES pinned')
})
