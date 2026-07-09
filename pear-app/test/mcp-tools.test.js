// In-process MCP tool server tests.

const test = require('brittle')
const {
  createMcpToolsServer,
  createMcpToolsClient,
  MAX_TIPS_LIMIT,
  MAX_TRANSLATE_CHARS
} = require('../bare/mcpTools.js')

test('listTools exposes exactly the four Curva tools with valid JSON Schema', async (t) => {
  const server = createMcpToolsServer({})
  const { tools } = await server.client.listTools()
  const names = tools.map((tool) => tool.name).sort()
  t.alike(names, ['getMatchState', 'getRecentTips', 'getRoomStats', 'translateText'], 'tool set')
  for (const tool of tools) {
    t.is(typeof tool.name, 'string')
    t.is(typeof tool.description, 'string')
    t.ok(tool.description.length > 0, 'description non-empty for ' + tool.name)
    t.is(tool.inputSchema.type, 'object', 'schema type object for ' + tool.name)
  }
})

test('getMatchState returns a normalized envelope even when source is null', async (t) => {
  const server = createMcpToolsServer({ getMatchState: () => null })
  const res = await server.call('getMatchState', {})
  t.absent(res.isError)
  t.ok(Array.isArray(res.content))
  t.is(res.content[0].type, 'text')
  const parsed = res.toolResult
  t.is(parsed.score.home, 0)
  t.is(parsed.score.away, 0)
  t.is(parsed.clockMs, 0)
  t.is(parsed.playing, false)
})

test('getMatchState reflects host-supplied clock', async (t) => {
  const server = createMcpToolsServer({
    getMatchState: () => ({ score: { home: 2, away: 1 }, clockMs: 47_000, kickoffAt: 1730000000000, playing: true, source: 'playhead' })
  })
  const res = await server.call('getMatchState', {})
  t.is(res.toolResult.score.home, 2)
  t.is(res.toolResult.score.away, 1)
  t.is(res.toolResult.clockMs, 47_000)
  t.is(res.toolResult.playing, true)
  t.is(res.toolResult.source, 'playhead')
})

test('getRoomStats coerces and clamps', async (t) => {
  const server = createMcpToolsServer({
    getRoomStats: () => ({ peerCount: 3.9, verifiedPeerCount: -1, uptimeMs: 12345, chatCount: 8 })
  })
  const res = await server.call('getRoomStats', {})
  t.is(res.toolResult.peerCount, 3)
  t.is(res.toolResult.verifiedPeerCount, 0, 'negatives clamped')
  t.is(res.toolResult.uptimeMs, 12345)
  t.is(res.toolResult.chatCount, 8)
})

test('getRecentTips uses in-process ring when no override provided', async (t) => {
  const server = createMcpToolsServer({})
  const now = Date.now()
  server.pushTip({ from: 'alice', to: 'bob', amountUsd: 1, txHash: '0xabc', at: now - 2000 })
  server.pushTip({ from: 'carol', to: 'dave', amountUsd: 2, txHash: '0xdef', at: now - 1000 })
  const res = await server.call('getRecentTips', { limit: 5 })
  t.absent(res.isError)
  t.is(res.toolResult.length, 2)
  t.is(res.toolResult[0].from, 'carol', 'most recent first')
  t.is(res.toolResult[0].amountUsd, 2)
})

test('getRecentTips respects limit bound', async (t) => {
  const server = createMcpToolsServer({})
  const now = Date.now()
  for (let i = 0; i < 40; i++) server.pushTip({ from: 'p' + i, to: 'q', amountUsd: i, at: now - (40 - i) * 100 })
  const res = await server.call('getRecentTips', { limit: 999 })
  t.ok(res.toolResult.length <= MAX_TIPS_LIMIT, 'response capped')
})

test('translateText round-trips through injected translator (bergamot seam)', async (t) => {
  const calls = []
  const translator = {
    async translate ({ text, sourceLang, targetLang }) {
      calls.push({ text, sourceLang, targetLang })
      // Match the wrapper the real bare/translate.js returns for the fake
      // engine used in tests: a prefixed echo.
      return `[${sourceLang}>${targetLang}] ${text}`
    }
  }
  const server = createMcpToolsServer({ translator })
  const res = await server.call('translateText', { text: 'goal from Messi', from: 'en', to: 'it' })
  t.absent(res.isError)
  t.is(res.toolResult.text, '[en>it] goal from Messi')
  t.is(res.toolResult.from, 'en')
  t.is(res.toolResult.to, 'it')
  t.is(res.toolResult.engine, 'bergamot')
  t.is(calls.length, 1)
  t.is(calls[0].sourceLang, 'en')
})

test('translateText refuses over-length input by relying on schema-side cap', async (t) => {
  const translator = { async translate ({ text }) { return text } }
  const server = createMcpToolsServer({ translator })
  const huge = 'x'.repeat(MAX_TRANSLATE_CHARS + 200)
  const res = await server.call('translateText', { text: huge, from: 'en', to: 'it' })
  t.absent(res.isError, 'still returns (server caps)')
  t.ok(res.toolResult.text.length <= MAX_TRANSLATE_CHARS, 'text truncated to schema max')
})

test('translateText surfaces isError when no translator wired', async (t) => {
  const server = createMcpToolsServer({})
  const res = await server.call('translateText', { text: 'hi', from: 'en', to: 'it' })
  t.ok(res.isError, 'isError=true when translator missing')
  t.ok(res.toolResult.error.includes('translator'), 'error message useful')
})

test('unknown tool returns an isError result rather than throwing', async (t) => {
  const server = createMcpToolsServer({})
  const res = await server.call('nope', {})
  t.ok(res.isError)
  t.ok(res.toolResult.error.includes('unknown tool'))
})

test('client passes SDK structural type: listTools/callTool are async fns', async (t) => {
  const server = createMcpToolsServer({})
  t.is(typeof server.client.listTools, 'function')
  t.is(typeof server.client.callTool, 'function')
  t.is(typeof server.client.listResources, 'function')
  t.is(typeof server.client.readResource, 'function')
  const resources = await server.client.listResources()
  t.alike(resources, { resources: [] })
})

test('createMcpToolsClient synthesizes match state + room stats from a fake room', async (t) => {
  const fakeRoom = {
    playhead: { state: () => ({ match_time_ms: 15_000, type: 'play', kickoff_at: 42 }) },
    swarm: { peers: new Map([['a', {}], ['b', {}]]) },
    identity: { verifiedPeerCount: () => 1 },
    chat: { count: () => 3 }
  }
  const server = createMcpToolsClient({ room: fakeRoom, startedAt: Date.now() - 10_000 })
  const state = (await server.call('getMatchState', {})).toolResult
  t.is(state.clockMs, 15_000)
  t.is(state.playing, true)
  const stats = (await server.call('getRoomStats', {})).toolResult
  t.is(stats.peerCount, 2)
  t.is(stats.verifiedPeerCount, 1)
  t.is(stats.chatCount, 3)
  t.ok(stats.uptimeMs >= 9_000, 'uptime approx elapsed')
})
