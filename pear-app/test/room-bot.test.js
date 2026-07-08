// Wave 13B brittle tests: QVAC LLM roomBot with MCP tool calling.
//
// The bot is exercised end-to-end WITHOUT booting @qvac/sdk or the real MCP
// server. Two seams:
//   - `sdkImpl`: fake @qvac/sdk module supplying loadModel / completion. The
//     factory in translate.js accepts this via loadSdkLlm().
//   - `mcpClientImpl`: a fake McpClient. Bypasses createHttpMcpClient() so we
//     can observe listTools() / callTool() invocations directly.
//   - `fetchImpl`: injected fetch for the HTTP MCP adapter itself when we
//     want to verify wire behavior.

const test = require('brittle')

const {
  createRoomBot,
  createHttpMcpClient,
  buildHistory,
  botFlagEnabled,
  SYSTEM_PROMPT,
  DEFAULT_MODEL_SRC,
  DEFAULT_BACKEND_URL,
  DEFAULT_MCP_PATH,
  RATE_LIMIT_MS
} = require('../bare/roomBot.js')

// -- Docs-verification memo -------------------------------------------------

test('docs-verification memo lives at the top of roomBot.js', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'bare', 'roomBot.js'), 'utf8')
  const head = src.slice(0, 3000)
  t.ok(head.includes('Docs-verification memo'), 'memo present at top')
  t.ok(head.includes('@qvac/sdk'), 'names the SDK it verifies against')
  t.ok(head.includes('QWEN3_600M_INST_Q4'), 'model choice named')
  t.ok(head.includes('mcp-adapter.d.ts'), 'cites McpClient .d.ts source')
  t.ok(head.includes('modelConfig.tools'), 'documents modelConfig.tools requirement')
  t.ok(head.includes('completionDone') || head.includes('CompletionRun'), 'documents streaming API surface')
})

// -- Helpers ----------------------------------------------------------------

function fakeChat () {
  const sent = []
  return {
    sent,
    async sendSystem (msg) {
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

/**
 * Fake @qvac/sdk module. loadModel() bumps a counter so tests can assert the
 * bot skipped loading when a shared handle was supplied. completion() returns
 * a synchronous CompletionRun with an events async iterable that emits the
 * pre-configured event script (contentDelta + toolCall + completionDone).
 */
function fakeSdk ({ events = null, tokens = ['Hello ', 'world'], toolInvokeResult = { ok: true } } = {}) {
  const calls = { loadModel: 0, completion: 0, unloadModel: 0 }
  const sdk = {
    async loadModel ({ modelSrc, modelType, modelConfig }) {
      calls.loadModel += 1
      calls.lastLoadArgs = { modelSrc, modelType, modelConfig }
      return 'fake-model-' + calls.loadModel
    },
    completion ({ modelId, history, mcp }) {
      calls.completion += 1
      calls.lastCompletionArgs = { modelId, history, mcp }
      const eventScript = events || (async function * () {
        for (const t of tokens) yield { type: 'contentDelta', text: t }
        yield { type: 'completionDone' }
      })()
      return {
        events: eventScript,
        final: Promise.resolve({ text: tokens.join(''), toolCalls: [] })
      }
    },
    async unloadModel () { calls.unloadModel += 1 }
  }
  return { sdk, calls, toolInvokeResult }
}

function fakeMcp () {
  const calls = []
  return {
    calls,
    async listTools () {
      calls.push({ method: 'listTools' })
      return { tools: [{ name: 'join_watch_party' }, { name: 'send_tip' }] }
    },
    async callTool ({ name, arguments: args }) {
      calls.push({ method: 'callTool', name, arguments: args })
      return { content: [{ type: 'text', text: 'ok:' + name }] }
    }
  }
}

// -- Feature-flag gate ------------------------------------------------------

test('feature-flag off: answer() returns null and never touches SDK / MCP', async (t) => {
  const chat = fakeChat()
  const events = []
  const { sdk, calls } = fakeSdk()
  const bot = createRoomBot({
    chat,
    flagEnabled: false,       // roomBot module flag OFF
    sdkImpl: sdk,
    mcpClientImpl: fakeMcp(),
    emit: (e, p) => events.push({ e, p })
  })
  const enabled = await bot.enable()
  t.absent(enabled.enabled, 'enable() returns disabled status when flag is off')
  t.is(calls.loadModel, 0, 'model never loaded')
  const result = await bot.answer('/bot help me tip', { sourcePeer: 'peerA' })
  t.is(result, null, 'answer() returns null with flag off')
  t.is(chat.sent.length, 0, 'no chat rows written')
  await bot.close()
})

// -- Load path: shared LLM handle skips loadModel --------------------------

test('shared LLM handle is reused (no loadModel called)', async (t) => {
  const chat = fakeChat()
  const { sdk, calls } = fakeSdk()
  const bot = createRoomBot({
    chat,
    flagEnabled: true,
    sdkImpl: sdk,
    mcpClientImpl: fakeMcp(),
    sharedLlmHandle: {
      modelId: 'shared-qwen-abc',
      completion: sdk.completion.bind(sdk)
    }
  })
  const st = await bot.enable()
  t.is(calls.loadModel, 0, 'loadModel was NOT called when sharedLlmHandle provided')
  t.is(st.modelId, 'shared-qwen-abc', 'reuses shared modelId')
  t.ok(st.modelLoaded, 'reports loaded state')
  await bot.close()
  t.is(calls.unloadModel, 0, 'shared handle is NEVER unloaded by roomBot.close()')
})

test('no shared LLM: bot loads model with modelConfig.tools = true', async (t) => {
  const chat = fakeChat()
  const { sdk, calls } = fakeSdk()
  const bot = createRoomBot({
    chat,
    flagEnabled: true,
    sdkImpl: sdk,
    mcpClientImpl: fakeMcp()
  })
  const st = await bot.enable()
  t.is(calls.loadModel, 1, 'loadModel called exactly once when no shared handle')
  t.ok(calls.lastLoadArgs.modelConfig, 'modelConfig object present')
  t.is(calls.lastLoadArgs.modelConfig.tools, true, 'modelConfig.tools = true was passed')
  t.is(calls.lastLoadArgs.modelType, 'llm', 'modelType=llm passed to sdk')
  t.ok(st.modelLoaded, 'reports loaded state')
  await bot.close()
  t.is(calls.unloadModel, 1, 'owned handle IS unloaded by roomBot.close()')
})

// -- MCP HTTP adapter -------------------------------------------------------

test('createHttpMcpClient.listTools() posts JSON-RPC 2.0 tools/list', async (t) => {
  const calls = []
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts })
    return {
      ok: true,
      status: 200,
      async json () {
        return { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'send_tip' }] } }
      }
    }
  }
  const mcp = createHttpMcpClient({
    url: 'http://localhost:3700/mcp',
    fetchImpl: fakeFetch
  })
  const res = await mcp.listTools()
  t.is(calls.length, 1, 'exactly one HTTP request')
  t.is(calls[0].url, 'http://localhost:3700/mcp', 'POST hits /mcp path')
  t.is(calls[0].opts.method, 'POST', 'HTTP method is POST')
  const body = JSON.parse(calls[0].opts.body)
  t.is(body.jsonrpc, '2.0', 'JSON-RPC 2.0 envelope')
  t.is(body.method, 'tools/list', 'method=tools/list')
  t.ok(body.id > 0, 'numeric request id')
  t.is(res.tools[0].name, 'send_tip', 'result unwrapped from envelope')
})

test('createHttpMcpClient.callTool() sends tools/call with arguments', async (t) => {
  const calls = []
  const fakeFetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body))
    return {
      ok: true,
      async json () {
        return { jsonrpc: '2.0', id: calls.length, result: { content: [{ type: 'text', text: 'ok' }] } }
      }
    }
  }
  const mcp = createHttpMcpClient({
    url: 'http://localhost:3700/mcp',
    fetchImpl: fakeFetch,
    authToken: 'sekrit'
  })
  await mcp.callTool({ name: 'send_tip', arguments: { amount: '1' } })
  t.is(calls[0].method, 'tools/call', 'method=tools/call')
  t.is(calls[0].params.name, 'send_tip', 'tool name in params')
  t.is(calls[0].params.arguments.amount, '1', 'arguments carried through')
})

test('createHttpMcpClient rejects when HTTP status is non-ok', async (t) => {
  const fakeFetch = async () => ({ ok: false, status: 502, async json () { return {} } })
  const mcp = createHttpMcpClient({
    url: 'http://localhost:3700/mcp',
    fetchImpl: fakeFetch
  })
  try {
    await mcp.listTools()
    t.fail('expected throw on non-ok status')
  } catch (err) {
    t.is(err.code, 'MCP_HTTP_ERROR', 'code=MCP_HTTP_ERROR')
    t.ok(err.message.includes('502'), 'status code surfaced in message')
  }
})

// -- Tool-call event routing -----------------------------------------------

test('toolCall event routes through mcp.callTool when invoke closure absent', async (t) => {
  const chat = fakeChat()
  const mcp = fakeMcp()
  // Event script: one toolCall (no invoke closure), one contentDelta, done.
  const eventScript = (async function * () {
    yield { type: 'toolCall', seq: 1, call: { id: 't1', name: 'send_tip', arguments: { amount: '1' } } }
    yield { type: 'contentDelta', text: 'tipped host 1 USDT' }
    yield { type: 'completionDone' }
  })()
  const { sdk } = fakeSdk({ events: eventScript })
  const emitted = []
  const bot = createRoomBot({
    chat,
    flagEnabled: true,
    sdkImpl: sdk,
    mcpClientImpl: mcp,
    emit: (e, p) => emitted.push({ e, p })
  })
  await bot.enable()
  const result = await bot.answer('tip host 1 USDT', { sourcePeer: 'peerA' })
  t.ok(result, 'answer returned a result')
  const toolCall = mcp.calls.find((c) => c.method === 'callTool')
  t.ok(toolCall, 'mcp.callTool was invoked (fallback path)')
  t.is(toolCall.name, 'send_tip', 'correct tool name routed')
  t.is(toolCall.arguments.amount, '1', 'arguments passed through')
  // Two chat rows: system:bot-query + system:bot-reply
  t.is(chat.sent.length, 2, 'query + reply broadcast')
  t.is(chat.sent[0].type, 'system:bot-query', 'first row is query')
  t.is(chat.sent[1].type, 'system:bot-reply', 'second row is reply')
  t.is(chat.sent[1].tool_calls.length, 1, 'reply carries the tool_call record')
  t.is(chat.sent[1].tool_calls[0].name, 'send_tip', 'tool_call.name preserved')
  t.ok(chat.sent[1].tool_calls[0].ok, 'tool_call.ok=true on success')
  await bot.close()
})

test('toolCall event prefers SDK-attached invoke closure when present', async (t) => {
  const chat = fakeChat()
  const mcp = fakeMcp()
  let invokeCalled = 0
  const eventScript = (async function * () {
    yield {
      type: 'toolCall',
      seq: 1,
      call: {
        id: 't1',
        name: 'join_watch_party',
        arguments: { roomId: 'demo' },
        invoke: async () => { invokeCalled += 1; return { joined: true } }
      }
    }
    yield { type: 'contentDelta', text: 'joined the room' }
    yield { type: 'completionDone' }
  })()
  const { sdk } = fakeSdk({ events: eventScript })
  const bot = createRoomBot({
    chat,
    flagEnabled: true,
    sdkImpl: sdk,
    mcpClientImpl: mcp
  })
  await bot.enable()
  await bot.answer('/bot join the party', { sourcePeer: 'peerB' })
  t.is(invokeCalled, 1, 'SDK invoke closure called once')
  const directCallToolCalls = mcp.calls.filter((c) => c.method === 'callTool')
  t.is(directCallToolCalls.length, 0, 'mcp.callTool NOT called when invoke closure is present')
  await bot.close()
})

// -- Rate limiter -----------------------------------------------------------

test('rate limit: two rapid queries from same peer silently drops the second', async (t) => {
  const chat = fakeChat()
  let clock = 100_000
  const { sdk } = fakeSdk()
  const emitted = []
  const bot = createRoomBot({
    chat,
    flagEnabled: true,
    sdkImpl: sdk,
    mcpClientImpl: fakeMcp(),
    now: () => clock,
    emit: (e, p) => emitted.push({ e, p })
  })
  await bot.enable()
  const first = await bot.answer('help', { sourcePeer: 'peerA' })
  t.ok(first, 'first query accepted')
  clock += 100    // well under 15s
  const second = await bot.answer('again', { sourcePeer: 'peerA' })
  t.is(second, null, 'second rapid query returns null')
  const rateLimitEvents = emitted.filter((e) => e.e === 'bot:rate-limited')
  t.is(rateLimitEvents.length, 1, 'exactly one bot:rate-limited event')
  // Advance past the window: third query from same peer succeeds.
  clock += RATE_LIMIT_MS + 1
  const third = await bot.answer('third', { sourcePeer: 'peerA' })
  t.ok(third, 'query after window succeeds')
  // Different peer bypasses the same-peer bucket.
  clock += 10
  const otherPeer = await bot.answer('what', { sourcePeer: 'peerB' })
  t.ok(otherPeer, 'different peer is not blocked by peerA bucket')
  await bot.close()
})

// -- History builder --------------------------------------------------------

test('buildHistory: system prompt + recent chat context are shaped correctly', async (t) => {
  const history = buildHistory({
    prompt: 'tip host',
    recentChat: [
      { handle: 'nico', text: 'goal!' },
      { by_peer: 'aabbccdd', text: 'seguo' }
    ]
  })
  t.is(history.length, 2, 'system + user roles')
  t.is(history[0].role, 'system', 'first message is system prompt')
  t.is(history[1].role, 'user', 'second is user turn')
  t.ok(history[0].content.includes('Curva'), 'system prompt names Curva')
  t.ok(history[1].content.includes('tip host'), 'user turn carries prompt')
  t.ok(history[1].content.includes('nico:'), 'context row uses handle when present')
  t.ok(history[1].content.includes('aabbccdd'), 'context row falls back to short peer id')
})

// -- Empty prompt guard -----------------------------------------------------

test('answer() rejects empty prompts', async (t) => {
  const chat = fakeChat()
  const { sdk } = fakeSdk()
  const emitted = []
  const bot = createRoomBot({
    chat,
    flagEnabled: true,
    sdkImpl: sdk,
    mcpClientImpl: fakeMcp(),
    emit: (e, p) => emitted.push({ e, p })
  })
  await bot.enable()
  const a = await bot.answer('', { sourcePeer: 'peerA' })
  t.is(a, null, 'empty string rejected')
  const b = await bot.answer('   ', { sourcePeer: 'peerA' })
  t.is(b, null, 'whitespace-only rejected')
  const errs = emitted.filter((e) => e.e === 'bot:error' && e.p.code === 'EMPTY_PROMPT')
  t.ok(errs.length >= 2, 'EMPTY_PROMPT errors emitted')
  t.is(chat.sent.length, 0, 'no chat rows written for empty prompts')
  await bot.close()
})

// -- Public constants -------------------------------------------------------

test('roomBot constants: model + defaults', async (t) => {
  t.is(DEFAULT_MODEL_SRC, 'QWEN3_600M_INST_Q4', 'default model matches commentator (share the load)')
  t.is(DEFAULT_BACKEND_URL, 'http://localhost:3700', 'default backend URL')
  t.is(DEFAULT_MCP_PATH, '/mcp', 'default MCP path')
  t.is(RATE_LIMIT_MS, 15_000, '15s per-peer rate limit')
  t.ok(SYSTEM_PROMPT.length > 100, 'system prompt is non-trivial')
  t.ok(SYSTEM_PROMPT.includes('MCP'), 'system prompt mentions MCP')
})

test('botFlagEnabled: reads CURVA_QVAC_BOT_ENABLED from env', async (t) => {
  const prev = process.env.CURVA_QVAC_BOT_ENABLED
  process.env.CURVA_QVAC_BOT_ENABLED = 'true'
  t.ok(botFlagEnabled(), '"true" enables')
  process.env.CURVA_QVAC_BOT_ENABLED = '0'
  t.absent(botFlagEnabled(), '"0" disables')
  delete process.env.CURVA_QVAC_BOT_ENABLED
  t.absent(botFlagEnabled(), 'unset disables')
  if (prev !== undefined) process.env.CURVA_QVAC_BOT_ENABLED = prev
})
