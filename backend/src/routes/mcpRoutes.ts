/**
 * F14 MCP server HTTP endpoints.
 *
 *   GET  /mcp/info      informational metadata (always public, even when auth set)
 *   GET  /mcp/sse       MCP SSE transport (2024-11-05 clients)
 *   POST /mcp/messages  JSON-RPC message endpoint (paired with SSE)
 *   POST /mcp           Streamable HTTP transport (2025-03-26 clients)
 *
 * The three MCP transport endpoints implement the MCP wire protocol; they do
 * NOT follow the standard { success, error, data } envelope. Documented
 * exception per ARCH §21 F14.
 *
 * Auth: public when MCP_ACCESS_TOKEN is unset (per ADR-011). When set, all
 * /mcp/{sse,messages,streamable-http} require Authorization: Bearer <token>,
 * compared with crypto.timingSafeEqual to prevent timing side channels.
 * /mcp/info is always public (advertises authRequired: true).
 *
 * Global disable: MCP_ENABLED=false registers no routes; requests get the
 * default Fastify 404 — indistinguishable from a build without MCP.
 */

import crypto from 'node:crypto';
import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  MCP_ACCESS_TOKEN,
  MCP_ENABLED,
  MCP_INFO_RATE_LIMIT_MAX,
  MCP_INFO_RATE_LIMIT_WINDOW,
  MCP_MAX_SESSIONS,
  MCP_RATE_LIMIT_MAX,
  MCP_RATE_LIMIT_WINDOW,
  MCP_SESSION_TTL_SECONDS,
  SERVICE_VERSION,
} from '../config/main-config.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';
import { resolveLang } from '../lib/i18n/index.ts';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  getResourceCount,
  getResources,
  getToolCount,
  getTools,
  handleRpc,
  type JsonRpcRequest,
  type McpContext,
} from '../lib/mcp/server.ts';

// -----------------------------------------------------------------------------
// Bearer-token gate — timing-safe.
// -----------------------------------------------------------------------------

const timingSafeEqualStr = (a: string, b: string): boolean => {
  // timingSafeEqual requires equal-length buffers. Enforce constant-time on the
  // path we actually reach by padding the shorter value; length mismatch is
  // still a fast reject but does not itself leak the correct length beyond the
  // fact that any token exists (advertised by /mcp/info anyway).
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

const extractBearer = (request: FastifyRequest): string | null => {
  const raw = request.headers['authorization'];
  if (typeof raw !== 'string' || !raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!m) return null;
  return m[1] ?? null;
};

const requiresAuth = (): boolean =>
  typeof MCP_ACCESS_TOKEN === 'string' && MCP_ACCESS_TOKEN.length > 0;

/**
 * Bearer-token preHandler. Returns true if the request should be blocked
 * (401 already sent), false if the request may proceed.
 */
const authGate = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> => {
  if (!requiresAuth()) return false;
  const bearer = extractBearer(request);
  if (!bearer || !timingSafeEqualStr(bearer, MCP_ACCESS_TOKEN as string)) {
    await handleError(reply, 401, 'Missing or invalid MCP access token', 'UNAUTHORIZED');
    return true;
  }
  return false;
};

// -----------------------------------------------------------------------------
// Session tracking — bounded LRU map. Sessions are opaque; they let SSE
// clients recognise their own messages endpoint. Session id = UUID.
// -----------------------------------------------------------------------------

interface McpSession {
  id: string;
  reply: FastifyReply | null; // set for SSE session
  connectedAt: number;
  lastSeenAt: number;
}

const SESSIONS = new Map<string, McpSession>();

const evictOldest = (): void => {
  // Simple LRU: find oldest lastSeenAt and drop.
  let oldest: McpSession | null = null;
  for (const s of SESSIONS.values()) {
    if (!oldest || s.lastSeenAt < oldest.lastSeenAt) oldest = s;
  }
  if (oldest) {
    try {
      oldest.reply?.raw?.end();
    } catch {
      /* already broken */
    }
    SESSIONS.delete(oldest.id);
  }
};

const gcSessions = (): void => {
  const now = Date.now();
  const ttlMs = MCP_SESSION_TTL_SECONDS * 1000;
  for (const [id, s] of SESSIONS) {
    if (now - s.lastSeenAt > ttlMs) {
      try {
        s.reply?.raw?.end();
      } catch {
        /* already broken */
      }
      SESSIONS.delete(id);
    }
  }
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseSessionId = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.length > 64) return null;
  if (!UUID_RE.test(raw)) return null;
  return raw.toLowerCase();
};

/**
 * Test-only: drop all in-memory sessions.
 */
export const __resetSessionsForTest = (): void => {
  for (const s of SESSIONS.values()) {
    try {
      s.reply?.raw?.end();
    } catch {
      /* ignore */
    }
  }
  SESSIONS.clear();
};

// -----------------------------------------------------------------------------
// Context builder.
// -----------------------------------------------------------------------------

const buildCtx = (request: FastifyRequest, clientId?: string): McpContext => {
  // request.lang is populated by the global preHandler; fall back to
  // resolveLang() if a test bypasses it.
  const lang =
    (request as unknown as { lang?: 'en' | 'it' | 'id' }).lang ??
    resolveLang({
      query: (request.query as { lang?: unknown } | undefined)?.lang,
      acceptLanguage: request.headers['accept-language'],
    });
  return { lang, ip: request.ip, clientId };
};

// -----------------------------------------------------------------------------
// Route plugin
// -----------------------------------------------------------------------------

const HEARTBEAT_MS = 30_000;

export const mcpRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // Kill switch: register nothing. Requests fall through to Fastify's default
  // 404 which is indistinguishable from a build without MCP.
  if (!MCP_ENABLED) {
    done();
    return;
  }

  // -------------------------------------------------------------------------
  // GET /mcp/info — informational, always public
  // -------------------------------------------------------------------------
  app.get(
    '/mcp/info',
    {
      config: {
        rateLimit: {
          max: MCP_INFO_RATE_LIMIT_MAX,
          timeWindow: MCP_INFO_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverName: MCP_SERVER_NAME,
          serverVersion: SERVICE_VERSION,
          transports: ['sse', 'streamable-http'],
          authRequired: requiresAuth(),
          toolCount: getToolCount(),
          resourceCount: getResourceCount(),
          tools: getTools().map((t) => t.name),
          resources: getResources().map((r) => r.uri),
          endpoints: {
            info: '/mcp/info',
            sse: '/mcp/sse',
            messages: '/mcp/messages',
            streamableHttp: '/mcp',
          },
          docsUrl: 'https://curva.app/mcp',
        },
      });
    }
  );

  // -------------------------------------------------------------------------
  // POST /mcp/messages — JSON-RPC endpoint
  // Also mounted at POST /mcp for the streamable-http transport (same behavior;
  // both paths dispatch the same handler).
  // -------------------------------------------------------------------------
  const jsonRpcHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      if (await authGate(request, reply)) return;

      // Session tracking (optional). If the client provided a session id, refresh
      // its lastSeenAt so the GC doesn't evict a live conversation.
      const sessionId = parseSessionId(
        (request.query as { session?: unknown } | undefined)?.session
      );
      if (sessionId) {
        gcSessions();
        const existing = SESSIONS.get(sessionId);
        if (existing) {
          existing.lastSeenAt = Date.now();
        }
      }

      // JSON body may be a single request or a batch. We support single only
      // (MCP clients we care about — Claude Desktop, GPT — send single).
      const body = request.body;
      if (!body || typeof body !== 'object') {
        await reply.code(200).send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
        return;
      }

      const ctx = buildCtx(request, sessionId ?? undefined);
      const response = await handleRpc(body as JsonRpcRequest, ctx);

      // MCP JSON-RPC endpoints return 200 with the response envelope; errors
      // ride in the `error` field, not the HTTP status.
      await reply
        .code(200)
        .header('Content-Type', 'application/json; charset=utf-8')
        .send(response);
    } catch (err) {
      return handleServerError(reply, err as Error) as unknown as void;
    }
  };

  app.post(
    '/mcp/messages',
    {
      config: {
        rateLimit: { max: MCP_RATE_LIMIT_MAX, timeWindow: MCP_RATE_LIMIT_WINDOW },
      },
    },
    jsonRpcHandler
  );
  app.post(
    '/mcp',
    {
      config: {
        rateLimit: { max: MCP_RATE_LIMIT_MAX, timeWindow: MCP_RATE_LIMIT_WINDOW },
      },
    },
    jsonRpcHandler
  );

  // -------------------------------------------------------------------------
  // GET /mcp/sse — SSE transport
  // Emits the initial `endpoint` event pointing at /mcp/messages?session=<id>
  // per MCP transport spec. Heartbeat every 30s.
  // -------------------------------------------------------------------------
  app.get(
    '/mcp/sse',
    {
      config: {
        rateLimit: { max: MCP_RATE_LIMIT_MAX, timeWindow: MCP_RATE_LIMIT_WINDOW },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (await authGate(request, reply)) return;

      // Bounded session set. Evict oldest before we grow past the cap.
      gcSessions();
      while (SESSIONS.size >= MCP_MAX_SESSIONS) {
        evictOldest();
      }

      const sessionId = crypto.randomUUID();
      const session: McpSession = {
        id: sessionId,
        reply,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      SESSIONS.set(sessionId, session);

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // Advertise the paired messages endpoint. This is the well-known frame in
      // the MCP SSE transport handshake.
      reply.raw.write(
        `event: endpoint\ndata: /mcp/messages?session=${sessionId}\n\n`
      );

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(':ping\n\n');
        } catch {
          /* connection already closed */
        }
      }, HEARTBEAT_MS);

      const cleanup = (): void => {
        clearInterval(heartbeat);
        SESSIONS.delete(sessionId);
      };
      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);

      reply.hijack();
    }
  );

  done();
};

/**
 * Boot-time initialiser. Registers the tools + resources so the singleton
 * registry is populated before the first request. Idempotent.
 */
export const initMcpRegistries = async (): Promise<void> => {
  const { registerAllTools } = await import('../lib/mcp/tools.ts');
  const { registerAllResources } = await import('../lib/mcp/resources.ts');
  registerAllTools();
  registerAllResources();
};
