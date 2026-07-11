/**
 * F14 MCP tool implementations.
 *
 * Each tool is a thin dispatcher over an existing Prisma query / helper module.
 * We deliberately do NOT HTTP-call our own routes — direct function calls
 * preserve correctness (PII redaction, self-tip filters, demo exclusion) and
 * avoid burning a socket per tool call.
 *
 * Every tool response is JSON encoded as a `text` content block per MCP tools
 * spec (Claude / GPT MCP clients consume text blobs and parse). Structured
 * data also lands in `structuredContent` for callers that support it.
 *
 * Rate limiting: applied at the Fastify layer BEFORE tools/call runs. Downstream
 * services enforce their own limits, so a tool spamming its underlying query
 * hits the same DB rate limits any HTTP caller would.
 */

import { ethers } from 'ethers';
import { Prisma } from '../../../prisma/generated/client.js';
import { prismaQuery } from '../prisma.ts';
import { shortenAddress } from '../../utils/miscUtils.ts';
import { formatUsdt } from '../evm/usdtIndexer.ts';
import { getAllConfiguredChains, getChain, getDefaultChain, getEnabledChains } from '../evm/chains.ts';
import { getProviderHealth } from '../evm/provider.ts';
import { get as getGoalLog } from '../liveMatch/goalLog.ts';
import { listModels, loadRegistry } from '../qvac/registry.ts';
import { t } from '../i18n/index.ts';
import { fetchEip3009Domain } from '../evm/eip3009.ts';
import {
  getMaxAmountBaseUnits,
  isFacilitatorEnabled,
  isOnlyRegisteredHosts,
  isTokenAllowed,
} from '../evm/facilitator.ts';
import { eventBus } from '../activity/eventBus.ts';
import { seederSupervisor } from '../pears/seeder.ts';
import {
  FOOTBALL_DATA_API_KEY,
  MCP_TOOL_PREPARE_TIP_ENABLED,
  SERVICE_STARTED_AT,
  SERVICE_VERSION,
} from '../../config/main-config.ts';
import {
  registerTool,
  type McpContext,
  type McpTool,
  type McpToolResult,
} from './server.ts';
import {
  getBroadcastRegions,
  getDisciplineRecord,
  getFixturesOnDate,
  getMatchSummary,
  getStandings,
  getTeamSquad,
  getVenueDetails,
} from '../qvac/sharedRag.ts';
import { recordMcpToolCall } from '../observability.ts';

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  const n = Math.floor(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
};

const isValidSlug = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-z0-9]([a-z0-9-]{2,30})[a-z0-9]$/.test(s);

const isValidCuid = (s: unknown): s is string =>
  typeof s === 'string' && /^c[a-z0-9]{20,}$/i.test(s);

const isValidEvmAddress = (s: unknown): s is string =>
  typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s);

const asText = (obj: unknown): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
  structuredContent: obj,
});

const asError = (msg: string): McpToolResult => ({
  content: [{ type: 'text', text: msg }],
  isError: true,
});

const maskHandle = (h: string): string =>
  h.length <= 3 ? h.slice(0, 1) + '***' : h.slice(0, 3) + '***';

// -----------------------------------------------------------------------------
// list_rooms
// -----------------------------------------------------------------------------

const listRoomsTool: McpTool = {
  name: 'list_rooms',
  title: 'List Curva rooms',
  description:
    'List active Curva watch-party rooms. Optionally filter by matchId, chainId, or activeOnly. Returns redacted host handles.',
  inputSchema: {
    type: 'object',
    properties: {
      matchId: { type: 'string', description: 'Filter by match CUID' },
      chainId: { type: 'number', description: 'Filter to a specific chain' },
      activeOnly: {
        type: 'boolean',
        description: 'Only return non-deleted rooms with future expiry (default true)',
      },
      limit: { type: 'number', minimum: 1, maximum: 100, default: 50 },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const activeOnly = args.activeOnly !== false;
    const limit = clampInt(args.limit, 1, 100, 50);
    const where: Record<string, unknown> = {};
    if (activeOnly) {
      where.deletedAt = null;
      where.expiresAt = { gt: new Date() };
    }
    if (typeof args.matchId === 'string') {
      if (!isValidCuid(args.matchId)) return asError('Invalid matchId');
      where.matchId = args.matchId;
    }
    const rows = await prismaQuery.room.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        match: {
          select: {
            id: true,
            kickoffUtc: true,
            stage: true,
            status: true,
            homeTeam: { select: { code: true, name: true } },
            awayTeam: { select: { code: true, name: true } },
          },
        },
      },
    });
    return asText({
      rooms: rows.map((r) => ({
        slug: r.slug,
        hostHandle: maskHandle(r.hostHandle),
        matchId: r.matchId,
        homeTeam: r.match?.homeTeam?.name ?? null,
        awayTeam: r.match?.awayTeam?.name ?? null,
        stage: r.match?.stage ?? null,
        status: r.match?.status ?? null,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        isAutoWarmed: r.isAutoWarmed,
      })),
      count: rows.length,
    });
  },
};

// -----------------------------------------------------------------------------
// get_match_live
// -----------------------------------------------------------------------------

const getMatchLiveTool: McpTool = {
  name: 'get_match_live',
  title: 'Get live match snapshot',
  description:
    'Return the latest cached live snapshot for a match: score, current minute, status, and recent goal log.',
  inputSchema: {
    type: 'object',
    properties: {
      matchId: {
        type: 'string',
        description: 'Match CUID or numeric externalId',
      },
    },
    required: ['matchId'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = args.matchId;
    if (typeof id !== 'string' || !id) return asError('matchId required');
    if (id.length > 64) return asError('matchId too long');
    const asNumber = /^[0-9]+$/.test(id) ? Number(id) : null;
    const match =
      asNumber !== null
        ? await prismaQuery.match.findUnique({
            where: { externalId: asNumber },
            select: {
              id: true,
              externalId: true,
              status: true,
              homeScore: true,
              awayScore: true,
              currentMinute: true,
              lastSyncedAt: true,
            },
          })
        : await prismaQuery.match.findUnique({
            where: { id },
            select: {
              id: true,
              externalId: true,
              status: true,
              homeScore: true,
              awayScore: true,
              currentMinute: true,
              lastSyncedAt: true,
            },
          });
    if (!match) return asError('Match not found');
    const liveDataEnabled = Boolean(FOOTBALL_DATA_API_KEY);
    const goals = liveDataEnabled
      ? getGoalLog(match.id).map((g) => ({
          minute: g.minute,
          scorer: g.scorer,
          team: g.team,
          homeScoreAfter: g.homeScoreAfter,
          awayScoreAfter: g.awayScoreAfter,
        }))
      : [];
    return asText({
      matchId: match.id,
      externalId: match.externalId ?? null,
      status: match.status,
      statusLabel: t(`matches.status.${match.status}`, ctx.lang),
      currentMinute: liveDataEnabled ? match.currentMinute : null,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      lastSyncedAt:
        liveDataEnabled && match.lastSyncedAt
          ? match.lastSyncedAt.toISOString()
          : null,
      liveDataEnabled,
      goals,
    });
  },
};

// -----------------------------------------------------------------------------
// get_leaderboard
// -----------------------------------------------------------------------------

interface RawTipperRow {
  from_address: string;
  tip_count: number | bigint;
  total_amount: string;
}
interface RawRecipientRow {
  to_address: string;
  tip_count: number | bigint;
  total_amount: string;
}
interface RawRoomRow {
  slug: string;
  host_handle: string;
  tip_count: number | bigint;
  total_amount: string;
}

const toInt = (v: number | bigint): number =>
  typeof v === 'bigint' ? Number(v) : v;

const resolveChainIds = (chainId: unknown): { ok: number[] } | { err: string } => {
  if (chainId === undefined || chainId === null) {
    return { ok: getAllConfiguredChains().map((c) => c.chainId) };
  }
  if (typeof chainId !== 'number' || !Number.isInteger(chainId)) {
    return { err: 'chainId must be an integer' };
  }
  const chain = getChain(chainId);
  if (!chain) return { err: `Chain ${chainId} is not supported` };
  return { ok: [chainId] };
};

const getLeaderboardTool: McpTool = {
  name: 'get_leaderboard',
  title: 'Get leaderboard',
  description:
    "Get top tippers or top rooms. scope=global returns top recipients + top tippers; scope=match returns top rooms in a match; scope=room returns top tippers for a room slug.",
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['global', 'match', 'room'] },
      identifier: {
        type: 'string',
        description: "matchId (for scope=match) or slug (for scope=room)",
      },
      chainId: { type: 'number' },
      limit: { type: 'number', minimum: 1, maximum: 100, default: 10 },
    },
    required: ['scope'],
    additionalProperties: false,
  },
  async handler(args) {
    const scope = args.scope;
    const limit = clampInt(args.limit, 1, 100, 10);
    const chainResult = resolveChainIds(args.chainId);
    if ('err' in chainResult) return asError(chainResult.err);
    const chainIds = chainResult.ok;

    if (scope === 'global') {
      const [recipients, tippers] = await Promise.all([
        prismaQuery.$queryRaw<RawRecipientRow[]>(Prisma.sql`
          SELECT te.to_address                        AS to_address,
                 COUNT(*)::int                       AS tip_count,
                 SUM(te.amount::numeric)::text       AS total_amount
            FROM tip_events te
           WHERE te.from_address <> te.to_address
             AND te.is_demo = false
             AND te.chain_id = ANY(${chainIds}::int[])
           GROUP BY te.to_address
           ORDER BY SUM(te.amount::numeric) DESC
           LIMIT ${limit}
        `),
        prismaQuery.$queryRaw<RawTipperRow[]>(Prisma.sql`
          SELECT te.from_address               AS from_address,
                 COUNT(*)::int                AS tip_count,
                 SUM(te.amount::numeric)::text AS total_amount
            FROM tip_events te
           WHERE te.from_address <> te.to_address
             AND te.is_demo = false
             AND te.chain_id = ANY(${chainIds}::int[])
           GROUP BY te.from_address
           ORDER BY SUM(te.amount::numeric) DESC
           LIMIT ${limit}
        `),
      ]);
      return asText({
        scope,
        chainIds,
        topRecipients: recipients.map((r) => ({
          address: shortenAddress(r.to_address),
          tipCount: toInt(r.tip_count),
          totalAmount: r.total_amount,
          totalAmountFormatted: formatUsdt(r.total_amount),
        })),
        topTippers: tippers.map((r) => ({
          address: shortenAddress(r.from_address),
          tipCount: toInt(r.tip_count),
          totalAmount: r.total_amount,
          totalAmountFormatted: formatUsdt(r.total_amount),
        })),
      });
    }
    if (scope === 'match') {
      const matchId = args.identifier;
      if (typeof matchId !== 'string' || !isValidCuid(matchId)) {
        return asError('identifier must be a valid matchId when scope=match');
      }
      const rows = await prismaQuery.$queryRaw<RawRoomRow[]>(Prisma.sql`
        SELECT r.slug                          AS slug,
               r.host_handle                  AS host_handle,
               COUNT(te.id)::int              AS tip_count,
               COALESCE(SUM(te.amount::numeric), 0)::text AS total_amount
          FROM rooms r
          LEFT JOIN tip_events te
            ON te.room_id = r.id
           AND te.from_address <> te.to_address
           AND te.is_demo = false
           AND te.chain_id = ANY(${chainIds}::int[])
         WHERE r.match_id = ${matchId}
           AND r.deleted_at IS NULL
           AND r.is_demo = false
         GROUP BY r.slug, r.host_handle
         ORDER BY COALESCE(SUM(te.amount::numeric), 0) DESC
         LIMIT ${limit}
      `);
      return asText({
        scope,
        matchId,
        chainIds,
        topRooms: rows.map((r) => ({
          slug: r.slug,
          hostHandle: maskHandle(r.host_handle),
          tipCount: toInt(r.tip_count),
          totalAmount: r.total_amount,
          totalAmountFormatted: formatUsdt(r.total_amount),
        })),
      });
    }
    if (scope === 'room') {
      const slug = args.identifier;
      if (typeof slug !== 'string' || !isValidSlug(slug)) {
        return asError('identifier must be a valid slug when scope=room');
      }
      const room = await prismaQuery.room.findUnique({
        where: { slug },
        select: { id: true, hostHandle: true, deletedAt: true },
      });
      if (!room || room.deletedAt) return asError('Room not found');
      const rows = await prismaQuery.$queryRaw<RawTipperRow[]>(Prisma.sql`
        SELECT te.from_address               AS from_address,
               COUNT(*)::int                AS tip_count,
               SUM(te.amount::numeric)::text AS total_amount
          FROM tip_events te
         WHERE te.room_id = ${room.id}
           AND te.from_address <> te.to_address
           AND te.is_demo = false
           AND te.chain_id = ANY(${chainIds}::int[])
         GROUP BY te.from_address
         ORDER BY SUM(te.amount::numeric) DESC
         LIMIT ${limit}
      `);
      return asText({
        scope,
        slug,
        hostHandle: maskHandle(room.hostHandle),
        chainIds,
        topTippers: rows.map((r) => ({
          address: shortenAddress(r.from_address),
          tipCount: toInt(r.tip_count),
          totalAmount: r.total_amount,
          totalAmountFormatted: formatUsdt(r.total_amount),
        })),
      });
    }
    return asError(`Unknown scope: ${String(scope)}`);
  },
};

// -----------------------------------------------------------------------------
// get_room_tips
// -----------------------------------------------------------------------------

const getRoomTipsTool: McpTool = {
  name: 'get_room_tips',
  title: 'Get tips for a room',
  description: 'Return the most recent tips sent to a Curva room (host).',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string' },
      chainId: { type: 'number' },
      limit: { type: 'number', minimum: 1, maximum: 100, default: 50 },
    },
    required: ['slug'],
    additionalProperties: false,
  },
  async handler(args) {
    if (!isValidSlug(args.slug)) return asError('Invalid slug');
    const limit = clampInt(args.limit, 1, 100, 50);
    const room = await prismaQuery.room.findUnique({
      where: { slug: args.slug },
      select: { id: true, hostHandle: true, deletedAt: true },
    });
    if (!room) return asError('Room not found');
    const where: Record<string, unknown> = { roomId: room.id };
    if (args.chainId !== undefined) {
      const chainResult = resolveChainIds(args.chainId);
      if ('err' in chainResult) return asError(chainResult.err);
      where.chainId = chainResult.ok[0];
    }
    const tips = await prismaQuery.tipEvent.findMany({
      where,
      orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
      take: limit,
    });
    return asText({
      slug: args.slug,
      hostHandle: maskHandle(room.hostHandle),
      tips: tips.map((t) => ({
        chainId: t.chainId,
        from: shortenAddress(t.fromAddress),
        to: shortenAddress(t.toAddress),
        amount: t.amount,
        amountFormatted: formatUsdt(t.amount),
        blockTime: t.blockTime.toISOString(),
        txHash: shortenAddress(t.txHash, 10, 6),
      })),
      count: tips.length,
    });
  },
};

// -----------------------------------------------------------------------------
// get_supported_chains
// -----------------------------------------------------------------------------

const getSupportedChainsTool: McpTool = {
  name: 'get_supported_chains',
  title: 'List supported chains',
  description:
    'List every configured EVM chain (enabled or not) with runtime health. Curva ships Sepolia enabled and Plasma testnet visible-but-disabled.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler() {
    const all = getAllConfiguredChains();
    const def = getDefaultChain();
    return asText({
      defaultChainId: def.chainId,
      chains: all.map((c) => {
        if (!c.enabled) {
          return {
            chainId: c.chainId,
            name: c.name,
            enabled: false,
            healthy: null,
            usdtAddress: c.usdtAddress ? shortenAddress(c.usdtAddress) : null,
            notes: c.notes,
          };
        }
        const h = getProviderHealth(c.chainId);
        return {
          chainId: c.chainId,
          name: c.name,
          enabled: true,
          healthy: h.lagSeconds === null ? null : h.healthy,
          lastBlockNumber: h.lastBlockNumber,
          lagSeconds: h.lagSeconds,
          usdtAddress: c.usdtAddress ? shortenAddress(c.usdtAddress) : null,
        };
      }),
    });
  },
};

// -----------------------------------------------------------------------------
// list_qvac_models
// -----------------------------------------------------------------------------

const listQvacModelsTool: McpTool = {
  name: 'list_qvac_models',
  title: 'List QVAC models',
  description:
    'List on-device QVAC AI models available to Curva clients (Bergamot translation, Whisper transcription, etc.). Filter by family or capability.',
  inputSchema: {
    type: 'object',
    properties: {
      family: { type: 'string' },
      capability: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(args) {
    const family = typeof args.family === 'string' ? args.family : undefined;
    const capability =
      typeof args.capability === 'string' ? args.capability : undefined;
    const reg = loadRegistry();
    const filtered = listModels({ family, capability });
    return asText({
      version: reg.version,
      generatedAt: reg.generatedAt,
      models: filtered.map((m) => ({
        id: m.id,
        name: m.name,
        family: m.family,
        capabilities: m.capabilities,
        size: m.size,
        sizeLabel: m.sizeLabel,
        license: m.license,
        status: m.status,
        downloadUrl: m.downloadUrl,
      })),
    });
  },
};

// -----------------------------------------------------------------------------
// get_room — single-slug room lookup (ARCH §21 F14 spec)
// -----------------------------------------------------------------------------

const getRoomTool: McpTool = {
  name: 'get_room',
  title: 'Get a Curva room',
  description:
    'Return a single Curva room by slug: match context, redacted host handle, expiry, and demo/auto-warmed flags.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'Room slug (lowercase, dash-separated)' },
    },
    required: ['slug'],
    additionalProperties: false,
  },
  async handler(args) {
    if (!isValidSlug(args.slug)) return asError('Invalid slug');
    const room = await prismaQuery.room.findUnique({
      where: { slug: args.slug },
      include: {
        match: {
          select: {
            id: true,
            kickoffUtc: true,
            stage: true,
            status: true,
            homeTeam: { select: { code: true, name: true } },
            awayTeam: { select: { code: true, name: true } },
          },
        },
      },
    });
    if (!room || room.deletedAt) return asError('Room not found');
    return asText({
      slug: room.slug,
      hostHandle: maskHandle(room.hostHandle),
      matchId: room.matchId,
      homeTeam: room.match?.homeTeam?.name ?? null,
      awayTeam: room.match?.awayTeam?.name ?? null,
      kickoffUtc: room.match?.kickoffUtc?.toISOString() ?? null,
      stage: room.match?.stage ?? null,
      status: room.match?.status ?? null,
      createdAt: room.createdAt.toISOString(),
      expiresAt: room.expiresAt.toISOString(),
      isAutoWarmed: room.isAutoWarmed,
      isDemo: room.isDemo,
    });
  },
};

// -----------------------------------------------------------------------------
// list_matches_today — matches with kickoff in the today window (ARCH §21 F14)
// -----------------------------------------------------------------------------

const listMatchesTodayTool: McpTool = {
  name: 'list_matches_today',
  title: 'List today\'s matches',
  description:
    'List matches with kickoff in the last 2h through the next 24h (the same window as GET /matches/today).',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler() {
    const now = new Date();
    const from = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const to = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const matches = await prismaQuery.match.findMany({
      where: { kickoffUtc: { gte: from, lte: to } },
      orderBy: { kickoffUtc: 'asc' },
      include: {
        homeTeam: { select: { code: true, name: true } },
        awayTeam: { select: { code: true, name: true } },
      },
    });
    return asText({
      windowFromUtc: from.toISOString(),
      windowToUtc: to.toISOString(),
      count: matches.length,
      matches: matches.map((m) => ({
        id: m.id,
        externalId: m.externalId ?? null,
        kickoffUtc: m.kickoffUtc.toISOString(),
        stage: m.stage,
        status: m.status,
        homeTeam: m.homeTeam ? { code: m.homeTeam.code, name: m.homeTeam.name } : null,
        awayTeam: m.awayTeam ? { code: m.awayTeam.code, name: m.awayTeam.name } : null,
        homeScore: m.homeScore,
        awayScore: m.awayScore,
      })),
    });
  },
};

// -----------------------------------------------------------------------------
// get_status — backend health snapshot (ARCH §21 F14 spec)
// -----------------------------------------------------------------------------

const getStatusTool: McpTool = {
  name: 'get_status',
  title: 'Get backend health snapshot',
  description:
    'Return backend health: DB ping + latency, active/total rooms, tips lifetime, seeder counts, chain provider health.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler() {
    const now = new Date();
    let db = { ok: false, latencyMs: 0 };
    const dbStart = Date.now();
    try {
      await prismaQuery.$queryRaw`SELECT 1`;
      db = { ok: true, latencyMs: Date.now() - dbStart };
    } catch {
      db = { ok: false, latencyMs: Date.now() - dbStart };
    }
    let activeRooms = 0;
    let totalRooms = 0;
    let totalTipsLifetime = 0;
    if (db.ok) {
      // W2-HIGH-03 (SECURITY_AUDIT MED-01): exclude demo rows from every
      // public counter the MCP status tool surfaces. Mirrors the filter used
      // by /metrics/live and /status.json.
      const [ar, tr, tl] = await Promise.all([
        prismaQuery.room
          .count({ where: { deletedAt: null, expiresAt: { gt: now }, isDemo: false } })
          .catch(() => 0),
        prismaQuery.room.count({ where: { isDemo: false } }).catch(() => 0),
        prismaQuery.tipEvent.count({ where: { isDemo: false } }).catch(() => 0),
      ]);
      activeRooms = ar;
      totalRooms = tr;
      totalTipsLifetime = tl;
    }
    const chains = getEnabledChains().map((c) => {
      const h = getProviderHealth(c.chainId);
      return {
        chainId: c.chainId,
        name: c.name,
        healthy: h.lagSeconds === null ? null : h.healthy,
        lagSeconds: h.lagSeconds,
      };
    });
    const seederInfo = {
      enabled: seederSupervisor.isEnabled(),
      activeRooms: seederSupervisor.getActiveRoomCount(),
      totalPeers: seederSupervisor.getTotalPeers(),
    };
    const recent = eventBus.getRecent({ limit: 5 }).map((e) => ({
      type: e.type,
      ts: new Date(e.ts).toISOString(),
    }));
    return asText({
      status: db.ok ? 'ok' : 'down',
      generatedAt: now.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - SERVICE_STARTED_AT) / 1000),
      version: SERVICE_VERSION,
      components: { db, seeder: seederInfo, chains },
      metrics: { activeRooms, totalRooms, totalTipsLifetime },
      recentEvents: recent,
    });
  },
};

// -----------------------------------------------------------------------------
// prepare_tip — gated behind MCP_TOOL_PREPARE_TIP_ENABLED
// -----------------------------------------------------------------------------

const EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

const prepareTipTool: McpTool = {
  name: 'prepare_tip',
  title: 'Prepare an EIP-3009 tip payload',
  description:
    'Return an unsigned EIP-712 TransferWithAuthorization payload the agent can sign locally and submit to POST /wdk/relay/eip3009 (F11 facilitator).',
  inputSchema: {
    type: 'object',
    properties: {
      chainId: { type: 'number' },
      hostSlug: { type: 'string' },
      amountBaseUnits: { type: 'string', description: 'Value in USDT base units (6 decimals)' },
      validitySeconds: {
        type: 'number',
        minimum: 60,
        maximum: 3600,
        default: 300,
      },
    },
    required: ['chainId', 'hostSlug', 'amountBaseUnits'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!isFacilitatorEnabled()) {
      return asError(t('mcp.prepare_tip_unavailable', ctx.lang));
    }
    if (typeof args.chainId !== 'number' || !Number.isInteger(args.chainId)) {
      return asError('chainId must be an integer');
    }
    const chain = getChain(args.chainId);
    if (!chain) return asError(`Chain ${args.chainId} is not supported`);
    if (!chain.enabled) return asError(`Chain ${args.chainId} is currently disabled`);
    if (!isValidSlug(args.hostSlug)) return asError('Invalid hostSlug');
    if (typeof args.amountBaseUnits !== 'string' || !/^[0-9]+$/.test(args.amountBaseUnits)) {
      return asError('amountBaseUnits must be a decimal uint string');
    }
    let valueBig: bigint;
    try {
      valueBig = BigInt(args.amountBaseUnits);
    } catch {
      return asError('amountBaseUnits is not a valid integer');
    }
    if (valueBig <= 0n) return asError('amountBaseUnits must be > 0');
    if (valueBig > getMaxAmountBaseUnits()) {
      return asError('Amount exceeds facilitator cap');
    }
    const tokenAddress = chain.usdtAddress;
    if (!isValidEvmAddress(tokenAddress) || !isTokenAllowed(tokenAddress)) {
      return asError('Chain has no allowed token configured');
    }
    // Resolve host.
    const room = await prismaQuery.room.findUnique({
      where: { slug: args.hostSlug },
      select: {
        hostSmartAddress: true,
        deletedAt: true,
      },
    });
    if (!room || room.deletedAt) return asError('Room not found');
    if (isOnlyRegisteredHosts() && !room.hostSmartAddress) {
      return asError('Room host address unknown');
    }
    const to = room.hostSmartAddress;

    // W4 CR-Major#5: resolve the actual EIP-712 domain from the token contract
    // rather than returning a hard-coded { name: 'USDT', version: '1' }. This
    // ensures the agent's signature recovers correctly against the true domain
    // when submitted to /wdk/relay/eip3009. Domain fetch is cached per (chain,
    // token) inside fetchEip3009Domain.
    const domain = await fetchEip3009Domain(args.chainId, tokenAddress);
    if (!domain) {
      return asError(t('errors.TOKEN_METADATA_UNAVAILABLE', ctx.lang));
    }

    const validity = clampInt(args.validitySeconds, 60, 3600, 300);
    const now = Math.floor(Date.now() / 1000);
    const validAfter = Math.max(0, now - 60);
    const validBefore = now + validity;
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    return asText({
      chainId: args.chainId,
      usdtAddress: tokenAddress,
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract,
      },
      types: EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES,
      message: {
        from: '0x0000000000000000000000000000000000000000',
        to,
        value: args.amountBaseUnits,
        validAfter,
        validBefore,
        nonce,
      },
      submitUrl: '/wdk/relay/eip3009',
      instructions:
        'Sign the message with your EOA using EIP-712 typed-data (replace `from` with your signer address before signing). Submit { chainId, tokenAddress, from, to, value, validAfter, validBefore, nonce, v, r, s } to POST /wdk/relay/eip3009.',
    });
  },
};

// -----------------------------------------------------------------------------
// Wave 3 F4 tools — backed by the shared RAG corpus (world-cup-2026.json).
//
// These are server-privileged in the sense that a peer running the pear app
// does not have to hold the full corpus locally to answer these questions.
// The backend-side lookup uses ONLY data seeded from
// backend/src/data/world-cup-2026.json — no upstream API calls, no
// database, no invented facts. That makes them safe to expose over MCP.
// -----------------------------------------------------------------------------

const scoreGetLiveTool: McpTool = {
  name: 'score.getLive',
  title: 'Get static WC26 match summary',
  description:
    'Return the static WC26 fixture summary for a match (kickoff, teams, stage, status). Backed by the shared RAG corpus (world-cup-2026.json). Does not include live minute-by-minute score — use get_match_live for that.',
  inputSchema: {
    type: 'object',
    properties: {
      matchId: {
        type: 'string',
        description: 'Match externalId (numeric) or the RAG doc id "match:<n>"',
      },
    },
    required: ['matchId'],
    additionalProperties: false,
  },
  async handler(args) {
    const id = args.matchId;
    if (typeof id !== 'string' || !id) {
      recordMcpToolCall('score.getLive', 'error');
      return asError('matchId required');
    }
    if (id.length > 64) {
      recordMcpToolCall('score.getLive', 'error');
      return asError('matchId too long');
    }
    // Accept "12345" or "match:12345".
    const lookupKey = /^\d+$/.test(id) ? Number(id) : id;
    try {
      const summary = getMatchSummary(lookupKey);
      if (!summary) {
        recordMcpToolCall('score.getLive', 'error');
        return asError('Match not found in WC26 corpus');
      }
      recordMcpToolCall('score.getLive', 'ok');
      return asText(summary);
    } catch (err) {
      recordMcpToolCall('score.getLive', 'error');
      return asError((err as Error)?.message || 'lookup failed');
    }
  },
};

const refDisciplineTool: McpTool = {
  name: 'ref.discipline',
  title: 'Get discipline record for a team in a match',
  description:
    'Return the yellow/red card + suspension record for a team in a match. Currently reports {available:false} because discipline data is not seeded in the WC26 corpus — the response includes a reason field so callers can fall back to the live feed.',
  inputSchema: {
    type: 'object',
    properties: {
      team: {
        type: 'string',
        description: '3-letter FIFA team code (e.g. USA, MEX, BRA)',
      },
      matchId: {
        type: 'string',
        description: 'Match externalId (numeric) or RAG doc id',
      },
    },
    required: ['team', 'matchId'],
    additionalProperties: false,
  },
  async handler(args) {
    const team = args.team;
    const matchId = args.matchId;
    if (typeof team !== 'string' || !/^[A-Z]{2,3}$/.test(team)) {
      recordMcpToolCall('ref.discipline', 'error');
      return asError('team must be a 2-3 letter uppercase code');
    }
    if (typeof matchId !== 'string' || !matchId || matchId.length > 64) {
      recordMcpToolCall('ref.discipline', 'error');
      return asError('matchId required');
    }
    try {
      const record = getDisciplineRecord(team, matchId);
      recordMcpToolCall('ref.discipline', 'ok');
      return asText(record);
    } catch (err) {
      recordMcpToolCall('ref.discipline', 'error');
      return asError((err as Error)?.message || 'lookup failed');
    }
  },
};

const stadiumGetFixturesTool: McpTool = {
  name: 'stadium.getFixtures',
  title: 'Get WC26 fixtures on a date',
  description:
    'Return all WC26 matches with a kickoff on the given UTC date (YYYY-MM-DD). Backed by the shared RAG corpus (world-cup-2026.json).',
  inputSchema: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: 'UTC date, YYYY-MM-DD (e.g. 2026-06-11)',
      },
    },
    required: ['date'],
    additionalProperties: false,
  },
  async handler(args) {
    const date = args.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      recordMcpToolCall('stadium.getFixtures', 'error');
      return asError('date must be YYYY-MM-DD');
    }
    try {
      const fixtures = getFixturesOnDate(date);
      recordMcpToolCall('stadium.getFixtures', 'ok');
      return asText({ date, count: fixtures.length, fixtures });
    } catch (err) {
      recordMcpToolCall('stadium.getFixtures', 'error');
      return asError((err as Error)?.message || 'lookup failed');
    }
  },
};

// -----------------------------------------------------------------------------
// Wave 5C additions — squad / venue / standings / broadcast tools.
//
// All four are backed by static JSON on disk (wc26-squads.json,
// wc26-venues.json, wc26-broadcasts.json) via the sharedRag accessors. They
// never touch the DB or a live API, so they are safe to expose over MCP with
// only lexical input validation.
// -----------------------------------------------------------------------------

const rosterGetSquadTool: McpTool = {
  name: 'roster.getSquad',
  title: 'Get WC26 team squad',
  description:
    'Return the shipped squad list for a team (name, position, number). Roster data is SAMPLE / placeholder until official FIFA announcements — response includes a source note when applicable.',
  inputSchema: {
    type: 'object',
    properties: {
      teamCode: {
        type: 'string',
        description: '3-letter FIFA team code, uppercase (e.g. USA, MEX, BRA)',
      },
    },
    required: ['teamCode'],
    additionalProperties: false,
  },
  async handler(args) {
    const code = args.teamCode;
    if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) {
      recordMcpToolCall('roster.getSquad', 'error');
      return asError('teamCode must be a 3-letter uppercase code');
    }
    try {
      const squad = getTeamSquad(code);
      if (!squad) {
        recordMcpToolCall('roster.getSquad', 'error');
        return asError(`Squad not found for team ${code}`);
      }
      if ('available' in squad && squad.available === false) {
        recordMcpToolCall('roster.getSquad', 'error');
        return asText(squad);
      }
      recordMcpToolCall('roster.getSquad', 'ok');
      return asText(squad);
    } catch (err) {
      recordMcpToolCall('roster.getSquad', 'error');
      return asError((err as Error)?.message || 'lookup failed');
    }
  },
};

const venueGetDetailsTool: McpTool = {
  name: 'venue.getDetails',
  title: 'Get WC26 venue metadata',
  description:
    'Return the metadata for a WC26 host-city stadium (name, city, country, capacity, elevation, match stages hosted). Data verified against FIFA host-city announcements.',
  inputSchema: {
    type: 'object',
    properties: {
      stadiumCode: {
        type: 'string',
        description: 'Venue code, e.g. "MEX-AZTECA", "USA-METLIFE"',
      },
    },
    required: ['stadiumCode'],
    additionalProperties: false,
  },
  async handler(args) {
    const code = args.stadiumCode;
    if (typeof code !== 'string' || !/^[A-Z]{2,4}-[A-Z0-9]+$/.test(code)) {
      recordMcpToolCall('venue.getDetails', 'error');
      return asError('stadiumCode must match /^[A-Z]{2,4}-[A-Z0-9]+$/');
    }
    try {
      const venue = getVenueDetails(code);
      if (!venue) {
        recordMcpToolCall('venue.getDetails', 'error');
        return asError(`Venue not found: ${code}`);
      }
      if ('available' in venue && venue.available === false) {
        recordMcpToolCall('venue.getDetails', 'error');
        return asText(venue);
      }
      recordMcpToolCall('venue.getDetails', 'ok');
      return asText(venue);
    } catch (err) {
      recordMcpToolCall('venue.getDetails', 'error');
      return asError((err as Error)?.message || 'lookup failed');
    }
  },
};

const standingsGetTableTool: McpTool = {
  name: 'standings.getTable',
  title: 'Get WC26 group standings',
  description:
    'Compute the standings table for a WC26 group letter (A-L) by aggregating finished fixtures in the shared RAG corpus. If no results are seeded, every team returns 0 played / 0 points. Not authoritative for live scores — use get_match_live for live data.',
  inputSchema: {
    type: 'object',
    properties: {
      group: {
        type: 'string',
        description: 'Single uppercase group letter A-L',
      },
    },
    required: ['group'],
    additionalProperties: false,
  },
  async handler(args) {
    const group = args.group;
    if (typeof group !== 'string' || !/^[A-L]$/.test(group)) {
      recordMcpToolCall('standings.getTable', 'error');
      return asError('group must be a single uppercase letter A-L');
    }
    try {
      const table = getStandings(group);
      recordMcpToolCall('standings.getTable', 'ok');
      return asText({ group, table });
    } catch (err) {
      recordMcpToolCall('standings.getTable', 'error');
      return asError((err as Error)?.message || 'lookup failed');
    }
  },
};

const broadcastGetRegionsTool: McpTool = {
  name: 'broadcast.getRegions',
  title: 'Get WC26 broadcast regions for a match',
  description:
    'Return the sample rights-holder list for a WC26 match. Broadcast rights are territorial and change frequently — the response always includes a disclaimer field. Not a substitute for consulting local listings.',
  inputSchema: {
    type: 'object',
    properties: {
      matchId: {
        type: 'number',
        description: 'Positive integer match externalId',
      },
    },
    required: ['matchId'],
    additionalProperties: false,
  },
  async handler(args) {
    const matchId = args.matchId;
    if (typeof matchId !== 'number' || !Number.isInteger(matchId) || matchId <= 0) {
      recordMcpToolCall('broadcast.getRegions', 'error');
      return asError('matchId must be a positive integer');
    }
    try {
      const payload = getBroadcastRegions(matchId);
      if ('available' in payload && payload.available === false) {
        recordMcpToolCall('broadcast.getRegions', 'error');
        return asText(payload);
      }
      recordMcpToolCall('broadcast.getRegions', 'ok');
      return asText(payload);
    } catch (err) {
      recordMcpToolCall('broadcast.getRegions', 'error');
      return asError((err as Error)?.message || 'lookup failed');
    }
  },
};

// -----------------------------------------------------------------------------
// F14 EXTRA TOOLS — voice-coach enrichment
//
// Four read-only tools, all bounded and demo-safe:
//   - get_prediction_pool  (Prisma: PredictionPool + Prediction sum)
//   - get_user_profile     (Prisma: TipEvent + Prediction + Room aggregations)
//   - get_h2h_history      (Static: world-cup-2026.json, filtered)
//   - get_tournament_bracket (Static: world-cup-2026.json, knockout stages)
//
// Data-source design decisions:
//   - No world-cup-2022.json file exists, so historical H2H comes ONLY from
//     the WC26 corpus filtered by team pair. Empty array = "no data seeded".
//   - Bracket returns the four knockout stages (r16, qf, sf, final) plus
//     third_place. All matches remain "TBD" until group play resolves — the
//     seeded fixtures still expose homeTeamCode/awayTeamCode as placeholders.
// -----------------------------------------------------------------------------

const H2H_ARRAY_CAP = 20;
const BRACKET_MATCH_CAP = 20;

// Load WC data source once and cache. Fallback to empty structure when missing
// so tools remain callable (per spec: gracefully degrade, do not throw).
interface WcMatch {
  externalId: number;
  homeTeamCode: string;
  awayTeamCode: string;
  kickoffUtc: string;
  stage: string;
  status: string;
  groupLabel?: string | null;
  venue?: unknown;
}
interface WcTeam {
  code: string;
  name: string;
  group?: string;
}
interface WcCorpus {
  meta?: { competition?: string };
  teams: WcTeam[];
  matches: WcMatch[];
}
let wcCache: WcCorpus | null = null;
let wcCacheLoaded = false;
const loadWcCorpus = (): WcCorpus | null => {
  if (wcCacheLoaded) return wcCache;
  wcCacheLoaded = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const p = path.resolve(process.cwd(), 'src/data/world-cup-2026.json');
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as WcCorpus;
    if (parsed && Array.isArray(parsed.teams) && Array.isArray(parsed.matches)) {
      wcCache = parsed;
    }
  } catch {
    wcCache = null;
  }
  return wcCache;
};

const isValidTeamCode = (s: unknown): s is string =>
  typeof s === 'string' && /^[A-Z]{2,3}$/.test(s);

const getPredictionPoolTool: McpTool = {
  name: 'get_prediction_pool',
  title: 'Get open prediction pools for a room',
  description:
    'Return the open (status=open) prediction pools for a Curva room slug: poolId, mode, options, deadline, and confirmed staked total. Capped at 20 rows.',
  inputSchema: {
    type: 'object',
    properties: {
      roomSlug: { type: 'string', description: 'Room slug' },
    },
    required: ['roomSlug'],
    additionalProperties: false,
  },
  async handler(args) {
    if (!isValidSlug(args.roomSlug)) return asError('Invalid roomSlug');
    try {
      const pools = await prismaQuery.predictionPool.findMany({
        where: { roomSlug: args.roomSlug, status: 'open' },
        orderBy: { createdAt: 'desc' },
        take: H2H_ARRAY_CAP,
      });
      return asText({
        roomSlug: args.roomSlug,
        count: pools.length,
        pools: pools.map((p) => ({
          poolId: p.id,
          matchId: p.matchId,
          mode: p.mode,
          entryStakeAtomic: p.entryStakeAtomic,
          deadlineMs: p.deadlineMs.toString(),
          status: p.status,
          totalStakedAtomic: p.totalStakedAtomic,
          chainId: p.chainId,
          options: p.mode === 'winner-only' ? ['HOME', 'AWAY', 'DRAW'] : ['exact-score'],
        })),
      });
    } catch (err) {
      return asError((err as Error)?.message || 'lookup failed');
    }
  },
};

const getUserProfileTool: McpTool = {
  name: 'get_user_profile',
  title: 'Get aggregate user profile',
  description:
    'Return aggregate stats for a peer address: totalTipsSent, totalTipsReceived, predictionsWon, predictionsLost, roomsCreated. Zeros returned for unknown addresses.',
  inputSchema: {
    type: 'object',
    properties: {
      ownerAddress: { type: 'string', description: 'Lowercase 0x... EVM address' },
    },
    required: ['ownerAddress'],
    additionalProperties: false,
  },
  async handler(args) {
    if (!isValidEvmAddress(args.ownerAddress)) return asError('Invalid ownerAddress');
    const addr = args.ownerAddress.toLowerCase();
    try {
      const [tipsSent, tipsReceived, predsWon, predsLost, roomsCreated] = await Promise.all([
        prismaQuery.tipEvent
          .count({ where: { fromAddress: addr, isDemo: false } })
          .catch(() => 0),
        prismaQuery.tipEvent
          .count({ where: { toAddress: addr, isDemo: false } })
          .catch(() => 0),
        prismaQuery.prediction
          .count({ where: { peerAddress: addr, status: 'won' } })
          .catch(() => 0),
        prismaQuery.prediction
          .count({ where: { peerAddress: addr, status: 'refunded' } })
          .catch(() => 0),
        prismaQuery.room
          .count({ where: { hostOwnerAddress: addr, deletedAt: null, isDemo: false } })
          .catch(() => 0),
      ]);
      return asText({
        address: shortenAddress(addr),
        totalTipsSent: tipsSent,
        totalTipsReceived: tipsReceived,
        predictionsWon: predsWon,
        predictionsLost: predsLost,
        roomsCreated,
      });
    } catch (err) {
      return asError((err as Error)?.message || 'lookup failed');
    }
  },
};

const getH2hHistoryTool: McpTool = {
  name: 'get_h2h_history',
  title: 'Get head-to-head history between two teams',
  description:
    'Return head-to-head matches between two team codes from the WC26 corpus. Empty array when data source is missing or no matches are seeded. Capped at 20 rows.',
  inputSchema: {
    type: 'object',
    properties: {
      teamA: { type: 'string', description: '2-3 letter FIFA code' },
      teamB: { type: 'string', description: '2-3 letter FIFA code' },
      competition: { type: 'string', description: 'Optional filter (unused when only WC26 is available)' },
    },
    required: ['teamA', 'teamB'],
    additionalProperties: false,
  },
  async handler(args) {
    if (!isValidTeamCode(args.teamA)) return asError('Invalid teamA');
    if (!isValidTeamCode(args.teamB)) return asError('Invalid teamB');
    const teamA = args.teamA;
    const teamB = args.teamB;
    const wc = loadWcCorpus();
    if (!wc) {
      return asText({
        teamA,
        teamB,
        competition: 'FIFA World Cup 2026',
        count: 0,
        matches: [],
        note: 'H2H data source unavailable',
      });
    }
    const matches = wc.matches
      .filter(
        (m) =>
          (m.homeTeamCode === teamA && m.awayTeamCode === teamB) ||
          (m.homeTeamCode === teamB && m.awayTeamCode === teamA),
      )
      .slice(0, H2H_ARRAY_CAP)
      .map((m) => ({
        externalId: m.externalId,
        homeTeamCode: m.homeTeamCode,
        awayTeamCode: m.awayTeamCode,
        kickoffUtc: m.kickoffUtc,
        stage: m.stage,
        status: m.status,
      }));
    return asText({
      teamA,
      teamB,
      competition: wc.meta?.competition ?? 'FIFA World Cup 2026',
      count: matches.length,
      matches,
    });
  },
};

const getTournamentBracketTool: McpTool = {
  name: 'get_tournament_bracket',
  title: 'Get WC26 tournament knockout bracket',
  description:
    'Return knockout bracket state (r16, qf, sf, final, third_place) from the WC26 corpus. Empty structure when data source is missing. Read-only static data.',
  inputSchema: {
    type: 'object',
    properties: {
      competition: {
        type: 'string',
        description: 'Currently only "wc2026" is supported',
      },
    },
    required: ['competition'],
    additionalProperties: false,
  },
  async handler(args) {
    if (typeof args.competition !== 'string' || args.competition.length > 32) {
      return asError('competition must be a string (max 32 chars)');
    }
    const wc = loadWcCorpus();
    if (!wc) {
      return asText({
        competition: args.competition,
        available: false,
        bracket: { r16: [], qf: [], sf: [], third_place: [], final: [] },
      });
    }
    const stages: Record<string, unknown[]> = {
      r16: [],
      qf: [],
      sf: [],
      third_place: [],
      final: [],
    };
    for (const m of wc.matches) {
      if (!(m.stage in stages)) continue;
      if (stages[m.stage].length >= BRACKET_MATCH_CAP) continue;
      stages[m.stage].push({
        externalId: m.externalId,
        homeTeamCode: m.homeTeamCode,
        awayTeamCode: m.awayTeamCode,
        kickoffUtc: m.kickoffUtc,
        status: m.status,
      });
    }
    return asText({
      competition: wc.meta?.competition ?? args.competition,
      available: true,
      bracket: stages,
    });
  },
};

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

/**
 * Register all F14 tools. Idempotent — safe to call at boot and again from
 * tests after __resetRegistryForTest().
 */
export const registerAllTools = (): void => {
  registerTool(listRoomsTool);
  registerTool(getRoomTool);
  registerTool(getMatchLiveTool);
  registerTool(listMatchesTodayTool);
  registerTool(getLeaderboardTool);
  registerTool(getRoomTipsTool);
  registerTool(getSupportedChainsTool);
  registerTool(listQvacModelsTool);
  registerTool(getStatusTool);
  if (MCP_TOOL_PREPARE_TIP_ENABLED) {
    registerTool(prepareTipTool);
  }
  // Wave 3 F4 additions.
  registerTool(scoreGetLiveTool);
  registerTool(refDisciplineTool);
  registerTool(stadiumGetFixturesTool);
  // Wave 5C additions.
  registerTool(rosterGetSquadTool);
  registerTool(venueGetDetailsTool);
  registerTool(standingsGetTableTool);
  registerTool(broadcastGetRegionsTool);
  // F14 extras: voice-coach enrichment.
  registerTool(getPredictionPoolTool);
  registerTool(getUserProfileTool);
  registerTool(getH2hHistoryTool);
  registerTool(getTournamentBracketTool);
};

// Test-only exports for direct unit testing without touching registry.
export const __toolsForTest = {
  listRoomsTool,
  getRoomTool,
  getMatchLiveTool,
  listMatchesTodayTool,
  getLeaderboardTool,
  getRoomTipsTool,
  getSupportedChainsTool,
  listQvacModelsTool,
  getStatusTool,
  prepareTipTool,
  scoreGetLiveTool,
  refDisciplineTool,
  stadiumGetFixturesTool,
  rosterGetSquadTool,
  venueGetDetailsTool,
  standingsGetTableTool,
  broadcastGetRegionsTool,
  getPredictionPoolTool,
  getUserProfileTool,
  getH2hHistoryTool,
  getTournamentBracketTool,
};

// Re-export McpContext for test files convenience.
export type { McpContext };
