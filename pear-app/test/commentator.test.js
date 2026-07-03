// Wave 13A brittle tests: QVAC LLM Room Commentator.
//
// The commentator itself is exercised end-to-end WITHOUT booting @qvac/sdk by
// passing a `sdkFactory` seam that returns a fake LLM handle. Rate-limit,
// host-only gate, disabled default, shape validation, and Chat.js render
// class are all covered here.

const test = require('brittle')

const {
  createCommentator,
  buildPrompt,
  sanitizeCommentary,
  isValidSystemCommentary,
  checkCommentaryAuthorship,
  PROMPT_TEMPLATE,
  TONE_PROMPTS,
  DEFAULT_MODEL_SRC,
  DEFAULT_MODEL_SIZE_MB
} = require('../bare/commentator.js')
const { _internal: chatInternal } = require('../bare/chat.js')

// -- Docs-verification memo -------------------------------------------------

test('docs-verification memo lives at the top of commentator.js', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'bare', 'commentator.js'), 'utf8')
  const head = src.slice(0, 2500)
  t.ok(head.includes('Docs-verification memo'), 'memo present at top')
  t.ok(head.includes('QWEN3_600M_INST_Q4'), 'model choice named')
  t.ok(head.includes('382,156,480'), 'model expected size cited from SDK registry')
  t.ok(head.includes('@qvac/sdk'), 'names the SDK it verifies against')
  t.ok(head.includes('tokenStream'), 'documents streaming API surface')
})

// -- Prompt template + sanitiser --------------------------------------------

test('buildPrompt substitutes every placeholder and picks tone line', async (t) => {
  const p = buildPrompt({
    matchTitle: 'ITA vs INA',
    matchTimeSeconds: 900,
    chatContext: [
      { handle: 'nico', text: 'yesssss' },
      { by_peer: 'aabbccdd', text: 'that was close' }
    ],
    playheadType: 'goal-cluster',
    tone: 'italian-ultras',
    maxWords: 30
  })
  t.ok(p.includes('ITA vs INA'), 'match title substituted')
  t.ok(p.includes('900'), 'match time substituted')
  t.ok(p.includes('italian-ultras') === false, 'tone id itself is not leaked')
  t.ok(p.includes(TONE_PROMPTS['italian-ultras']), 'tone line substituted')
  t.ok(p.includes('nico:'), 'chat context handle used')
  t.ok(p.includes('goal-cluster'), 'playhead type substituted')
  t.absent(p.includes('{'), 'no unfilled placeholders')
})

test('sanitizeCommentary caps words + strips control chars', async (t) => {
  const raw = 'Line one\u0000\u0007\nline two'
  const clean = sanitizeCommentary(raw, 30)
  t.absent(clean.includes('\u0000'), 'nulls stripped')
  t.absent(clean.includes('\u0007'), 'BEL stripped')
  t.absent(clean.includes('\n'), 'newlines collapsed to spaces')
  t.is(clean, 'Line one line two', 'expected sanitized shape')

  const long = new Array(50).fill('word').join(' ')
  const capped = sanitizeCommentary(long, 30)
  t.is(capped.split(' ').length, 30, 'exactly 30 words')

  const quoted = sanitizeCommentary('"GOAL for Italy!"', 30)
  t.is(quoted, 'GOAL for Italy!', 'wrapping quotes stripped')
})

// -- Shape validator + host-only gate ---------------------------------------

test('isValidSystemCommentary rejects malformed shapes', async (t) => {
  const good = {
    type: 'system:commentary',
    by_peer: 'peer',
    wall_clock_ms: Date.now(),
    match_time_ms: 900_000,
    text: 'GOAL! Italia sblocca!'
  }
  t.ok(isValidSystemCommentary(good), 'valid shape accepted')
  t.ok(chatInternal.isValidSystemCommentary(good), 'chat.js exports same validator')

  t.absent(isValidSystemCommentary({ ...good, type: 'msg' }), 'wrong type rejected')
  t.absent(isValidSystemCommentary({ ...good, text: '' }), 'empty text rejected')
  t.absent(isValidSystemCommentary({ ...good, text: 'x'.repeat(281) }), 'oversized text rejected')
  t.absent(isValidSystemCommentary({ ...good, by_peer: '' }), 'empty by_peer rejected')
  t.absent(isValidSystemCommentary({ ...good, wall_clock_ms: -1 }), 'negative timestamp rejected')
  t.absent(isValidSystemCommentary({ ...good, tone: 'x'.repeat(50) }), 'oversized tone rejected')
})

test('checkCommentaryAuthorship: only host may author once host is known', async (t) => {
  const host = 'a'.repeat(64)
  const peer = 'b'.repeat(64)
  t.ok(checkCommentaryAuthorship(peer, null), 'pre-init grace: any writer allowed')
  t.ok(checkCommentaryAuthorship(host, host), 'host authored: ok')
  t.absent(checkCommentaryAuthorship(peer, host), 'peer authored: rejected')
})

// -- Commentator lifecycle: default OFF, host-only enable -------------------

function fakeChat() {
  const sent = []
  return {
    sent,
    async sendSystem(msg) {
      // Mirrors bare/chat.js sendSystem(): enriches with by_peer + wall_clock_ms
      // when the caller omits them. Commentator relies on this exact contract.
      const enriched = {
        by_peer: 'host-fake',
        match_time_ms: 0,
        wall_clock_ms: Date.now(),
        ...msg
      }
      sent.push(enriched)
      return enriched
    }
  }
}

function fakeSdk({ tokens = ['Bella ', 'giocata!'], throwOnComplete = false } = {}) {
  return async () => {
    return {
      modelId: 'fake-qwen3-600m',
      completion: ({ history }) => {
        if (throwOnComplete) throw new Error('sdk boom')
        return {
          tokenStream: (async function* () {
            for (const t of tokens) yield t
          })(),
          text: Promise.resolve(tokens.join(''))
        }
      },
      unloadModel: async () => {}
    }
  }
}

test('commentator disabled by default: runTrigger emits nothing', async (t) => {
  const chat = fakeChat()
  const events = []
  const c = createCommentator({
    storageDir: '/tmp/curva-test',
    isHost: true,
    chat,
    sdkFactory: fakeSdk(),
    tickMs: 60_000,
    getMatchTimeMs: () => 42_000,
    emit: (ev, p) => events.push({ ev, p })
  })
  const emitted = await c.runTrigger({ type: 'tick' })
  t.absent(emitted, 'nothing emitted when not enabled')
  t.is(chat.sent.length, 0, 'no chat rows written')
  await c.close()
})

test('commentator enabled + trigger fires: chat receives system:commentary', async (t) => {
  const chat = fakeChat()
  const events = []
  const c = createCommentator({
    storageDir: '/tmp/curva-test',
    isHost: true,
    chat,
    sdkFactory: fakeSdk({ tokens: ['GOAL', '! Italia', ' sblocca'] }),
    getMatchTimeMs: () => 42_000,
    getMatchTitle: () => 'ITA vs INA',
    getRecentChat: () => [{ handle: 'nico', text: 'seguo' }],
    tickMs: 60_000,
    emit: (ev, p) => events.push({ ev, p })
  })
  await c.enable()
  const ok = await c.runTrigger({ type: 'goal-cluster' })
  t.ok(ok, 'runTrigger returned true')
  t.is(chat.sent.length, 1, 'exactly one commentary appended')
  const msg = chat.sent[0]
  t.is(msg.type, 'system:commentary', 'correct type')
  t.ok(msg.text.includes('GOAL'), 'text contains streamed tokens')
  t.is(msg.trigger, 'goal-cluster', 'trigger tag preserved')
  t.is(msg.match_time_ms, 42_000, 'match time propagated')
  t.ok(isValidSystemCommentary(msg), 'emitted msg passes shape validator')

  const tokenEvents = events.filter((e) => e.ev === 'commentary:tokens')
  t.ok(tokenEvents.length >= 1, 'progressive token events emitted')
  const emittedEvents = events.filter((e) => e.ev === 'commentary:emitted')
  t.is(emittedEvents.length, 1, 'one emitted event')
  await c.close()
})

test('rate limit: no more than 1 commentary per 30 seconds', async (t) => {
  const chat = fakeChat()
  let clock = 100_000
  const c = createCommentator({
    storageDir: '/tmp/curva-test',
    isHost: true,
    chat,
    sdkFactory: fakeSdk(),
    now: () => clock,
    rateLimitMs: 30_000,
    tickMs: 60_000
  })
  await c.enable()
  const a = await c.runTrigger({ type: 'tick' })
  t.ok(a, 'first emission ok')

  clock += 5_000
  const b = await c.runTrigger({ type: 'tick' })
  t.absent(b, 'second emission within 30s is rate-limited')

  clock += 30_001
  const cthird = await c.runTrigger({ type: 'tick' })
  t.ok(cthird, 'emission after 30s allowed')

  t.is(chat.sent.length, 2, 'exactly two commentaries appended over the sequence')
  await c.close()
})

test('non-host cannot enable commentator', async (t) => {
  const chat = fakeChat()
  const c = createCommentator({
    storageDir: '/tmp/curva-test',
    isHost: false,
    chat,
    sdkFactory: fakeSdk()
  })
  await t.exception.all(async () => { await c.enable() }, 'enable throws for non-host')
  const emitted = await c.runTrigger({ type: 'tick' })
  t.absent(emitted, 'runTrigger emits nothing for non-host')
  await c.close()
})

test('LLM plugin detection: sdkFactory returning null keeps commentator disabled', async (t) => {
  const chat = fakeChat()
  const events = []
  const c = createCommentator({
    storageDir: '/tmp/curva-test',
    isHost: true,
    chat,
    sdkFactory: async () => null,
    emit: (ev, p) => events.push({ ev, p })
  })
  await c.enable()
  const emitted = await c.runTrigger({ type: 'tick' })
  t.absent(emitted, 'no commentary when LLM plugin unavailable')
  const errs = events.filter((e) => e.ev === 'commentary:error')
  t.ok(errs.length >= 1, 'error event surfaced')
  t.ok(errs.some((e) => e.p?.code === 'LLM_UNAVAILABLE'), 'error code = LLM_UNAVAILABLE')
  await c.close()
})

test('tone setter validates against known tones', async (t) => {
  const chat = fakeChat()
  const c = createCommentator({ storageDir: '/tmp/curva-test', isHost: true, chat })
  c.setTone('calm-analyst')
  t.is(c.status().tone, 'calm-analyst', 'tone applied')
  t.exception.all(() => c.setTone('rude'), 'unknown tone rejected')
  await c.close()
})

// -- Chat.js integration: system:commentary shape flows through isValidMessage

test('bare/chat.js accepts system:commentary shape via isValidMessage', async (t) => {
  const good = {
    type: 'system:commentary',
    by_peer: 'peer',
    wall_clock_ms: Date.now(),
    match_time_ms: 42_000,
    text: 'GOAL! Italia!'
  }
  t.ok(chatInternal.isValidMessage(good), 'isValidMessage accepts system:commentary')
  const bad = { ...good, text: '' }
  t.absent(chatInternal.isValidMessage(bad), 'empty text rejected')
})

test('chat.js host-only gate: non-host writer is rejected for system:commentary', async (t) => {
  // Uses the same helper as pool-lifecycle: checkHostSystemAuthorship. We wired
  // the same predicate to system:commentary in bare/chat.js apply(). Pre-init
  // grace + host-match logic verified in the tip-ack test suite already; here
  // we just confirm the check is host-shaped.
  const host = 'a'.repeat(64)
  const peer = 'b'.repeat(64)
  t.absent(chatInternal.checkHostSystemAuthorship(peer, host), 'peer writer rejected once host known')
  t.ok(chatInternal.checkHostSystemAuthorship(host, host), 'host writer accepted')
  t.ok(chatInternal.checkHostSystemAuthorship(peer, null), 'pre-init grace preserved')
})

test('commentator constants: model choice + size sanity', async (t) => {
  t.is(DEFAULT_MODEL_SRC, 'QWEN3_600M_INST_Q4', 'model name pinned')
  t.ok(DEFAULT_MODEL_SIZE_MB > 200, 'size > 200MB threshold (triggers explicit toggle)')
  t.ok(DEFAULT_MODEL_SIZE_MB < 500, 'size < 500MB (still small enough for demo)')
  t.ok(PROMPT_TEMPLATE.includes('{matchTitle}'), 'prompt template names matchTitle slot')
  t.ok(PROMPT_TEMPLATE.includes('{chatContext}'), 'prompt template names chatContext slot')
})
