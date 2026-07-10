// Wave-final QVAC polish (F1) brittle tests: reasoning_budget +
// remove_thinking_from_context + deleteCache lifecycle across all five LLM
// call sites in bare/.
//
// Docs-verification memo ---------------------------------------------------
//
// Source of truth for the two completion fields is the installed @qvac/sdk
// schema at pear-app/node_modules/@qvac/sdk/dist/schemas/completion-stream.js
//   line 66-73: reasoning_budget = z.number().int().min(-1) with -1 = keep on,
//               0 = disable, positive = cap the reasoning channel at N tokens.
//   line 73+  : remove_thinking_from_context: z.boolean() strips <think> from
//               the model's kvCache prefix state after the call.
//
// Source of truth for the deleteCache API is
//   pear-app/node_modules/@qvac/sdk/dist/client/api/delete-cache.d.ts:22
//     deleteCache({ kvCacheKey }) : Promise<{ success: boolean }>
//
// This suite exercises the completion() call arguments AND the close() ->
// deleteCache path for every module that talks to the LLM.

const test = require('brittle')

const {
  createVoiceCoach
} = require('../bare/voiceCoach.js')
const {
  createCommentator
} = require('../bare/commentator.js')
const {
  createRoomBot
} = require('../bare/roomBot.js')
const {
  createAskTheFrame
} = require('../bare/askTheFrame.js')
const {
  createGoalPipeline
} = require('../bare/goalPipeline.js')

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fakeChat () {
  const sent = []
  const systemSent = []
  return {
    sent,
    systemSent,
    async send (m) { sent.push(m); return { ...m, wall_clock_ms: 111 } },
    async sendSystem (m) {
      const enriched = { by_peer: 'fake', match_time_ms: 0, wall_clock_ms: 222, ...m }
      systemSent.push(enriched)
      return enriched
    }
  }
}

function fakeLlmHandle ({ tokens = ['ok'], stopReason = 'eos' } = {}) {
  const calls = { completion: 0, args: [] }
  return {
    modelId: 'qwen-fake',
    completion (params) {
      calls.completion += 1
      calls.args.push(params)
      const script = (async function * () {
        for (const t of tokens) yield { type: 'contentDelta', text: t }
        yield { type: 'completionDone', stopReason }
      })()
      return {
        events: script,
        final: Promise.resolve({ contentText: tokens.join(''), toolCalls: [] })
      }
    },
    _calls: calls
  }
}

function fakeSttSdk ({ events = [] } = {}) {
  const session = {
    write () {},
    end () {},
    destroy () {},
    [Symbol.asyncIterator] () {
      let i = 0
      return {
        async next () {
          if (i >= events.length) return { value: undefined, done: true }
          return { value: events[i++], done: false }
        }
      }
    }
  }
  return {
    async transcribeStream () { return session }
  }
}

function makeDeleteCacheProbe () {
  const calls = []
  return {
    calls,
    fn (args) { calls.push(args); return { success: true } }
  }
}

// ---------------------------------------------------------------------------
// F1 assertions: reasoning_budget + remove_thinking_from_context per module
// ---------------------------------------------------------------------------

test('voiceCoach sets reasoning_budget=0 + remove_thinking_from_context=true', async (t) => {
  const chat = fakeChat()
  const llm = fakeLlmHandle({ tokens: ['sub the striker'] })
  const sdk = fakeSttSdk({ events: [{ type: 'text', text: 'should I sub?' }] })
  const coach = createVoiceCoach({
    chat,
    sdk,
    sharedLlmHandle: llm,
    roomSlug: 'demo'
  })
  await coach.startTurn()
  await new Promise((r) => setTimeout(r, 0))
  await coach.endTurn()
  await new Promise((r) => setTimeout(r, 0))
  t.is(llm._calls.completion, 1, 'exactly one completion() fired')
  const params = llm._calls.args[0]
  t.is(params.reasoning_budget, 0, 'voice coach disables reasoning channel')
  t.is(params.remove_thinking_from_context, true, 'voice coach strips thinking from context')
  t.is(params.kvCache, 'voicecoach:room:demo', 'per-room kvCache key present')
  await coach.close()
})

test('commentator sets reasoning_budget=0 + remove_thinking_from_context=true', async (t) => {
  const chat = fakeChat()
  const llm = fakeLlmHandle({ tokens: ['Ultras roar!'] })
  const c = createCommentator({
    storageDir: '/tmp',
    isHost: true,
    chat,
    sdkFactory: async () => ({ modelId: llm.modelId, completion: llm.completion }),
    roomSlug: 'ultras',
    getMatchTimeMs: () => 10_000,
    getMatchTitle: () => 'Italy vs France',
    getRecentChat: () => []
  })
  await c.enable()
  const fired = await c.runTrigger({ type: 'tick' })
  t.ok(fired, 'runTrigger emitted')
  t.is(llm._calls.completion, 1, 'exactly one completion() fired')
  const params = llm._calls.args[0]
  t.is(params.reasoning_budget, 0, 'commentator disables reasoning channel')
  t.is(params.remove_thinking_from_context, true, 'commentator strips thinking from context')
  t.is(params.captureThinking, true, 'commentator still captures thinking events for ghost preview')
  t.is(params.kvCache, 'commentator:room:ultras', 'per-room kvCache key present')
  await c.close()
})

test('roomBot sets reasoning_budget=-1 (unlimited) + remove_thinking_from_context=true', async (t) => {
  const chat = fakeChat()
  const llm = fakeLlmHandle({ tokens: ['Press higher on their playmaker.'] })
  const bot = createRoomBot({
    chat,
    sharedLlmHandle: { modelId: llm.modelId, completion: llm.completion },
    flagEnabled: true,
    roomSlug: 'tactics',
    mcpClientImpl: {
      async listTools () { return { tools: [] } },
      async callTool () { return { content: [] } }
    }
  })
  await bot.enable()
  const res = await bot.answer('should we press?', {
    sourcePeer: 'peer-1',
    recentChat: []
  })
  t.ok(res, 'answer returned a reply')
  t.is(llm._calls.completion, 1, 'exactly one completion() fired')
  const params = llm._calls.args[0]
  t.is(params.reasoning_budget, -1, 'roomBot keeps reasoning channel unlimited')
  t.is(params.remove_thinking_from_context, true, 'roomBot strips thinking from context')
  t.is(params.kvCache, 'roombot:room:tactics', 'per-room kvCache key present')
  await bot.close()
})

test('askTheFrame sets reasoning_budget=0 + remove_thinking_from_context=true', async (t) => {
  const chat = fakeChat()
  const llm = fakeLlmHandle({ tokens: ['A midfield press.'] })
  const vlm = {
    async caption () { return { ok: true, caption: 'Two players contest at midfield.' } }
  }
  const ask = createAskTheFrame({
    vlm,
    sharedLlmHandle: { modelId: llm.modelId, completion: llm.completion },
    chat,
    roomSlug: 'frame-room'
  })
  const res = await ask.ask({ image: 'stub', question: 'What is happening?' })
  t.ok(res.ok, 'ask returned ok')
  t.is(llm._calls.completion, 1, 'exactly one completion() fired')
  const params = llm._calls.args[0]
  t.is(params.reasoning_budget, 0, 'askTheFrame disables reasoning channel')
  t.is(params.remove_thinking_from_context, true, 'askTheFrame strips thinking from context')
  t.is(params.kvCache, 'askframe:room:frame-room', 'per-room kvCache key present')
  await ask.close()
})

// ---------------------------------------------------------------------------
// F1 assertions: close() -> deleteCache path
// ---------------------------------------------------------------------------

test('voiceCoach close() calls sdk.deleteCache and emits voice:kvcache-cleared', async (t) => {
  const chat = fakeChat()
  const llm = fakeLlmHandle({ tokens: ['ok'] })
  const probe = makeDeleteCacheProbe()
  const sdk = {
    async transcribeStream () { return { write () {}, end () {}, destroy () {}, [Symbol.asyncIterator] () { return { async next () { return { value: undefined, done: true } } } } } },
    async deleteCache (args) { return probe.fn(args) }
  }
  const events = []
  const coach = createVoiceCoach({
    chat,
    sdk,
    sharedLlmHandle: llm,
    roomSlug: 'room-A',
    emit: (e, p) => events.push({ e, p })
  })
  await coach.close()
  t.is(probe.calls.length, 1, 'deleteCache called once')
  t.is(probe.calls[0].kvCacheKey, 'voicecoach:room:room-A', 'kvCacheKey scoped per room')
  t.ok(events.some((ev) => ev.e === 'voice:kvcache-cleared'), 'voice:kvcache-cleared event emitted')
})

test('commentator close() calls injected deleteCache and emits commentator:kvcache-cleared', async (t) => {
  const chat = fakeChat()
  const llm = fakeLlmHandle()
  const probe = makeDeleteCacheProbe()
  const events = []
  const c = createCommentator({
    storageDir: '/tmp',
    isHost: true,
    chat,
    sdkFactory: async () => ({ modelId: llm.modelId, completion: llm.completion, deleteCache: probe.fn }),
    roomSlug: 'room-B',
    getMatchTimeMs: () => 0,
    emit: (e, p) => events.push({ e, p })
  })
  await c.enable()
  await c.close()
  t.is(probe.calls.length, 1, 'deleteCache called once')
  t.is(probe.calls[0].kvCacheKey, 'commentator:room:room-B', 'kvCacheKey scoped per room')
  t.ok(events.some((ev) => ev.e === 'commentator:kvcache-cleared'), 'commentator:kvcache-cleared event emitted')
})

test('commentator close() accepts deleteCacheImpl opt directly', async (t) => {
  const chat = fakeChat()
  const probe = makeDeleteCacheProbe()
  const events = []
  const c = createCommentator({
    storageDir: '/tmp',
    isHost: true,
    chat,
    // no sdkFactory: commentator never boots. close() should still clear the
    // kvCache via the explicitly-injected impl.
    deleteCacheImpl: probe.fn,
    roomSlug: 'lonely',
    getMatchTimeMs: () => 0,
    emit: (e, p) => events.push({ e, p })
  })
  await c.close()
  t.is(probe.calls.length, 1, 'deleteCache still called via deleteCacheImpl opt')
  t.is(probe.calls[0].kvCacheKey, 'commentator:room:lonely', 'kvCacheKey scoped per room')
})

test('roomBot close() calls deleteCacheImpl and emits roombot:kvcache-cleared', async (t) => {
  const chat = fakeChat()
  const llm = fakeLlmHandle()
  const probe = makeDeleteCacheProbe()
  const events = []
  const bot = createRoomBot({
    chat,
    sharedLlmHandle: { modelId: llm.modelId, completion: llm.completion },
    flagEnabled: true,
    roomSlug: 'tactics-B',
    deleteCacheImpl: probe.fn,
    emit: (e, p) => events.push({ e, p }),
    mcpClientImpl: { async listTools () { return { tools: [] } }, async callTool () { return {} } }
  })
  await bot.enable()
  await bot.close()
  t.is(probe.calls.length, 1, 'deleteCache called once')
  t.is(probe.calls[0].kvCacheKey, 'roombot:room:tactics-B', 'kvCacheKey scoped per room')
  t.ok(events.some((ev) => ev.e === 'roombot:kvcache-cleared'), 'roombot:kvcache-cleared event emitted')
})

test('askTheFrame close() calls deleteCacheImpl and emits askframe:kvcache-cleared', async (t) => {
  const chat = fakeChat()
  const llm = fakeLlmHandle()
  const probe = makeDeleteCacheProbe()
  const events = []
  const ask = createAskTheFrame({
    vlm: { async caption () { return { ok: true, caption: 'x' } } },
    sharedLlmHandle: { modelId: llm.modelId, completion: llm.completion },
    chat,
    roomSlug: 'ask-room',
    deleteCacheImpl: probe.fn,
    emit: (e, p) => events.push({ e, p })
  })
  await ask.close()
  t.is(probe.calls.length, 1, 'deleteCache called once')
  t.is(probe.calls[0].kvCacheKey, 'askframe:room:ask-room', 'kvCacheKey scoped per room')
  t.ok(events.some((ev) => ev.e === 'askframe:kvcache-cleared'), 'askframe:kvcache-cleared event emitted')
})

test('goalPipeline close() calls deleteCacheImpl and emits goalpipe:kvcache-cleared', async (t) => {
  const probe = makeDeleteCacheProbe()
  const events = []
  const pipeline = createGoalPipeline({
    ocr: { async read () { return { ok: true, blocks: [] } } },
    goalCard: { async parse () { return { ok: false, reason: 'n/a' } } },
    roomSlug: 'goal-room',
    deleteCacheImpl: probe.fn,
    emit: (e, p) => events.push({ e, p })
  })
  await pipeline.close()
  t.is(probe.calls.length, 1, 'deleteCache called once')
  t.is(probe.calls[0].kvCacheKey, 'goalpipe:room:goal-room', 'kvCacheKey scoped per room')
  t.ok(events.some((ev) => ev.e === 'goalpipe:kvcache-cleared'), 'goalpipe:kvcache-cleared event emitted')
})

// ---------------------------------------------------------------------------
// Regression: close() must be tolerant when no deleteCache impl is available
// (guarantees test suites that never wire the SDK do not hang).
// ---------------------------------------------------------------------------

test('all five modules close() cleanly with NO deleteCache impl wired', async (t) => {
  const chat = fakeChat()
  const llm = fakeLlmHandle()

  const coach = createVoiceCoach({
    chat, sdk: fakeSttSdk(), sharedLlmHandle: llm, roomSlug: 'a'
  })
  await coach.close()
  t.pass('voiceCoach close resolved without deleteCache')

  const c = createCommentator({
    storageDir: '/tmp', isHost: true, chat,
    sdkFactory: async () => ({ modelId: llm.modelId, completion: llm.completion }),
    roomSlug: 'b', getMatchTimeMs: () => 0
  })
  await c.enable()
  await c.close()
  t.pass('commentator close resolved without deleteCache on sdkHandle')

  const bot = createRoomBot({
    chat,
    sharedLlmHandle: { modelId: llm.modelId, completion: llm.completion },
    flagEnabled: true, roomSlug: 'c',
    mcpClientImpl: { async listTools () { return { tools: [] } }, async callTool () { return {} } }
  })
  await bot.enable()
  await bot.close()
  t.pass('roomBot close resolved without deleteCache')

  const ask = createAskTheFrame({
    vlm: { async caption () { return { ok: true, caption: 'x' } } },
    sharedLlmHandle: { modelId: llm.modelId, completion: llm.completion },
    chat, roomSlug: 'd'
  })
  await ask.close()
  t.pass('askTheFrame close resolved without deleteCache')

  const pipeline = createGoalPipeline({
    ocr: { async read () { return { ok: true, blocks: [] } } },
    goalCard: { async parse () { return { ok: false, reason: 'n/a' } } },
    roomSlug: 'e'
  })
  await pipeline.close()
  t.pass('goalPipeline close resolved without deleteCache')
})
