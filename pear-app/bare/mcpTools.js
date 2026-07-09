// Curva in-process MCP tools (Semifinal QVAC depth).
//
// Docs-verification memo ---------------------------------------------------
//
// The QVAC SDK's `completion({ mcp: [{ client, includeResources }] })` param
// takes any object whose structural type matches `McpClient`:
//   { listTools(): Promise<{tools: McpTool[]}>,
//     callTool({name, arguments}): Promise<McpToolCallResult|Record<string,unknown>>,
//     listResources?, readResource? }
// Verified against pear-app/node_modules/@qvac/sdk/dist/schemas/mcp-adapter.d.ts.
// This means we do NOT need to install @modelcontextprotocol/sdk — the SDK's
// mcp-adapter builds the LLM tool schema straight off `listTools()`. That is
// the recommended pattern in the official docs:
// https://docs.qvac.tether.io/ai-capabilities/text-generation/ (MCP section,
// fetched 2026-07-10).
//
// The tools exposed here are Curva-specific and use ONLY data that already
// lives in the Bare worker. We do NOT accept peer-controlled arguments that
// map to destructive actions; all four tools are read-only introspection
// helpers, plus one deterministic Bergamot translate call.
//
// Tools:
//   - getMatchState()               -> { score, clock, kickoffAt, playing, source }
//   - getRoomStats()                -> { peerCount, verifiedPeerCount, uptimeMs, chatCount }
//   - getRecentTips({ limit? })     -> [{ from, to, amountUsd, txHash, at }, ...]
//   - translateText({ text, from, to }) -> { text, from, to, engine }
//
// The renderer surfaces this same client via workers/main.js so a debug UI
// can call any tool directly (workflow: renderer -> IPC -> mcpTools.callTool).

const MAX_TIPS_LIMIT = 20
const MAX_TRANSLATE_CHARS = 500
const RECENT_TIPS_WINDOW_MS = 6 * 60 * 60 * 1000  // 6h retention for the ring
const TIPS_RING_SIZE = 128

/**
 * Build a Curva MCP server + a same-process client that speaks its
 * JSON-Schema-typed tools. Because the SDK only cares about the structural
 * client type, we return a client whose calls fan out to plain-JS handlers.
 *
 * @param {{
 *   getMatchState?: () => any,       // { score:{home,away}, clockMs, kickoffAt, playing?, source? }
 *   getRoomStats?: () => any,        // { peerCount, verifiedPeerCount, uptimeMs, chatCount }
 *   getRecentTips?: (limit?:number) => Array<any>, // returns cloned entries; if omitted we use the in-process ring
 *   translator?: {
 *     translate: (opts:{text:string, sourceLang:string, targetLang:string}) => Promise<string> | string
 *   } | null,
 *   log?: (level:string, msg:string, extra?:any) => void
 * }} opts
 */
function createMcpToolsServer (opts = {}) {
  const {
    getMatchState = () => null,
    getRoomStats = () => ({}),
    getRecentTips = null,
    translator = null,
    log = () => {}
  } = opts

  // In-process tip ring; populated by pushTip(). Kept as a bounded fifo so a
  // long-running room does not leak memory.
  const tipRing = []
  function pushTip (tip) {
    if (!tip || typeof tip !== 'object') return
    const now = Date.now()
    const entry = {
      from: String(tip.from || '').slice(0, 64),
      to: String(tip.to || '').slice(0, 64),
      amountUsd: Number(tip.amountUsd) || 0,
      txHash: typeof tip.txHash === 'string' ? tip.txHash.slice(0, 128) : null,
      at: typeof tip.at === 'number' ? tip.at : now
    }
    tipRing.push(entry)
    while (tipRing.length > TIPS_RING_SIZE) tipRing.shift()
    // Cull entries older than the retention window.
    const cutoff = now - RECENT_TIPS_WINDOW_MS
    while (tipRing.length > 0 && tipRing[0].at < cutoff) tipRing.shift()
  }

  const tools = Object.freeze([
    {
      name: 'getMatchState',
      description: 'Read the current match state (score, clock in ms, kickoff timestamp) from the Curva playhead.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'getRoomStats',
      description: 'Report room-scoped metrics: connected peers, identity-verified peers, uptime, chat count.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'getRecentTips',
      description: 'List recent USDT tips in this room, most recent first. Values are in whole USD, hashes are on-chain tx hashes.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_TIPS_LIMIT } },
        additionalProperties: false
      }
    },
    {
      name: 'translateText',
      description: 'Translate short text (<=500 chars) via on-device Bergamot NMT. Use ISO 639-1 codes for from/to.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: MAX_TRANSLATE_CHARS },
          from: { type: 'string', minLength: 2, maxLength: 5 },
          to: { type: 'string', minLength: 2, maxLength: 5 }
        },
        required: ['text', 'from', 'to'],
        additionalProperties: false
      }
    }
  ])

  function textResult (payload, isError = false) {
    // MCP tool call result envelope. `content[]` with a text block is the
    // canonical shape LLMs recognize; `toolResult` mirrors the parsed value
    // for callers that prefer structured data.
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    return {
      content: [{ type: 'text', text }],
      toolResult: payload,
      isError: !!isError
    }
  }

  async function invokeTool (name, args) {
    switch (name) {
      case 'getMatchState': {
        const raw = safe(getMatchState, null)
        if (!raw || typeof raw !== 'object') {
          return textResult({ score: { home: 0, away: 0 }, clockMs: 0, kickoffAt: null, playing: false, source: 'unknown' })
        }
        return textResult({
          score: {
            home: Number(raw.score?.home) || 0,
            away: Number(raw.score?.away) || 0
          },
          clockMs: Math.max(0, Number(raw.clockMs ?? raw.match_time_ms ?? 0) | 0),
          kickoffAt: raw.kickoffAt ?? raw.kickoff_at ?? null,
          playing: !!raw.playing,
          source: typeof raw.source === 'string' ? raw.source.slice(0, 32) : 'playhead'
        })
      }
      case 'getRoomStats': {
        const raw = safe(getRoomStats, {}) || {}
        return textResult({
          peerCount: Math.max(0, Number(raw.peerCount) || 0) | 0,
          verifiedPeerCount: Math.max(0, Number(raw.verifiedPeerCount) || 0) | 0,
          uptimeMs: Math.max(0, Number(raw.uptimeMs) || 0) | 0,
          chatCount: Math.max(0, Number(raw.chatCount) || 0) | 0
        })
      }
      case 'getRecentTips': {
        const rawLimit = Number(args?.limit)
        const limit = Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(MAX_TIPS_LIMIT, rawLimit | 0))
          : 5
        let rows = null
        if (typeof getRecentTips === 'function') {
          try {
            rows = getRecentTips(limit)
          } catch (err) {
            // Code review fix (High): log the accessor failure so a broken
            // getRecentTips does not become a silent fallback to the empty ring
            // (which would have the LLM cheerfully claim "no recent tips").
            log('warn', 'getRecentTips accessor threw', { message: err && err.message, limit })
            rows = null
          }
        }
        if (!Array.isArray(rows)) {
          rows = tipRing.slice(-limit).reverse()
        }
        // Redact obvious PII: only keep the fields the tool declared.
        const clean = rows.slice(0, limit).map((r) => ({
          from: String(r?.from || '').slice(0, 64),
          to: String(r?.to || '').slice(0, 64),
          amountUsd: Number(r?.amountUsd) || 0,
          txHash: typeof r?.txHash === 'string' ? r.txHash.slice(0, 128) : null,
          at: typeof r?.at === 'number' ? r.at : null
        }))
        return textResult(clean)
      }
      case 'translateText': {
        const text = typeof args?.text === 'string' ? args.text.slice(0, MAX_TRANSLATE_CHARS) : ''
        const from = typeof args?.from === 'string' ? args.from.toLowerCase().slice(0, 5) : ''
        const to = typeof args?.to === 'string' ? args.to.toLowerCase().slice(0, 5) : ''
        if (text.length === 0 || from.length < 2 || to.length < 2) {
          return textResult({ error: 'text, from, to are all required' }, true)
        }
        if (!translator || typeof translator.translate !== 'function') {
          return textResult({ error: 'translator not available in this session' }, true)
        }
        try {
          const outRaw = await Promise.resolve(translator.translate({ text, sourceLang: from, targetLang: to }))
          const outText = typeof outRaw === 'string' ? outRaw : (outRaw && outRaw.text) || ''
          return textResult({ text: outText, from, to, engine: 'bergamot' })
        } catch (err) {
          log('warn', 'mcp translateText failed', { message: err && err.message })
          return textResult({ error: String((err && err.message) || 'translate failed').slice(0, 200) }, true)
        }
      }
      default:
        return textResult({ error: 'unknown tool: ' + name }, true)
    }
  }

  /**
   * A same-process MCP client that satisfies the QVAC SDK structural type.
   * `includeResources: false` at call sites means listResources/readResource
   * are never invoked, but we expose no-op stubs anyway so any adapter that
   * probes for them does not throw.
   */
  const client = {
    async listTools () {
      return { tools: tools.map((t) => ({ ...t })) }
    },
    async callTool ({ name, arguments: args }) {
      if (typeof name !== 'string') {
        return textResult({ error: 'name required' }, true)
      }
      const result = await invokeTool(name, args || {})
      return result
    },
    async listResources () { return { resources: [] } },
    async readResource () { return { contents: [] } }
  }

  return {
    client,
    tools,
    pushTip,
    /** Peek at the tip ring for tests / diagnostics; does not mutate. */
    peekTips () { return tipRing.slice() },
    /** Directly invoke a tool (for tests + IPC bridge). */
    call (name, args) { return client.callTool({ name, arguments: args || {} }) }
  }
}

function safe (fn, fallback) {
  try { return fn() } catch { return fallback }
}

/**
 * Convenience: bind a Curva room + translator into a ready MCP client. Used
 * by workers/main.js when the roomBot flag is on.
 */
function createMcpToolsClient ({ room, translator, log, startedAt } = {}) {
  const bornAt = typeof startedAt === 'number' ? startedAt : Date.now()
  const server = createMcpToolsServer({
    getMatchState: () => {
      const st = room?.playhead?.state?.() || null
      if (!st) return null
      return {
        // Curva does not carry a live scoreboard state in v1; expose the
        // playhead clock as the LLM-visible signal.
        score: { home: 0, away: 0 },
        clockMs: Math.max(0, Number(st.match_time_ms || 0)),
        kickoffAt: typeof st.kickoff_at === 'number' ? st.kickoff_at : null,
        playing: st.type === 'play',
        source: 'playhead'
      }
    },
    getRoomStats: () => {
      const peers = (room?.swarm?.peers instanceof Map ? room.swarm.peers.size : 0) || 0
      const verified = (room?.identity?.verifiedPeerCount?.() ?? 0) | 0
      const chatCount = (room?.chat?.count?.() ?? 0) | 0
      return {
        peerCount: peers,
        verifiedPeerCount: verified,
        uptimeMs: Math.max(0, Date.now() - bornAt),
        chatCount
      }
    },
    translator,
    log
  })
  return server
}

module.exports = {
  createMcpToolsServer,
  createMcpToolsClient,
  MAX_TIPS_LIMIT,
  MAX_TRANSLATE_CHARS,
  TIPS_RING_SIZE
}
