/**
 * Tip leaderboard routes (F3).
 *
 *   GET /leaderboard/:slug                 — top tippers in a published room
 *   GET /leaderboard/global                — top recipients + top tippers globally
 *   GET /leaderboard/global/match/:matchId — top rooms by tip total for a match
 *
 * All aggregation runs in Postgres via $queryRaw with parameterized Prisma.sql
 * templates (NEVER string concatenation, per database-architect handoff and
 * OWASP SQL Injection Prevention Cheat Sheet).
 *
 * Self-tip exclusion: per the Section 19 open question + architect decision,
 * we exclude rows where `from_address = to_address` so hosts cannot inflate
 * their own leaderboard.
 *
 * Cache: 60s TTL keyed by (route, slug/matchId, limit). Stampede-protected.
 * Rate limit: 60/min/IP via @fastify/rate-limit.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { Prisma } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { TtlCache } from '../lib/cache.ts';
import {
  LEADERBOARD_CACHE_TTL_MS,
  LEADERBOARD_RATE_LIMIT_MAX,
  LEADERBOARD_RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
} from '../utils/errorHandler.ts';
import { isValidSlug, isValidCuid, parseBoundedInt } from '../utils/curvaValidators.ts';
import { shortenAddress } from '../utils/miscUtils.ts';
import { formatUsdt } from '../lib/evm/usdtIndexer.ts';
import { parseChainIdFilter, type ChainFilterResult } from '../lib/evm/chainFilter.ts';
import { t } from '../lib/i18n/index.ts';

// F10: leaderboard cache key now includes chainId scope ("all" or the explicit
// chainId). Bumped capacity to 500 per the architect open-question #6 so the
// per-chain x per-slug x per-limit fan-out stays cache-friendly.
const leaderboardCache = new TtlCache<unknown>(500);

/**
 * Test-only: clear the leaderboard memo cache between cases. Production code
 * MUST NOT call this; the cache is owned by the route file.
 */
export const __resetLeaderboardCacheForTest = (): void => {
  leaderboardCache.clear();
};

/**
 * Build a stable cache key and the chainIds[] parameter from a successful
 * parseChainIdFilter result (CHAIN_DISABLED warning is propagated separately).
 */
type ScopeOk = Extract<ChainFilterResult, { kind: 'all' } | { kind: 'specific' }>;
const buildChainScope = (parsed: ScopeOk): { key: string; chainIds: number[] } => {
  if (parsed.kind === 'specific') {
    return { key: String(parsed.chainIds[0]), chainIds: parsed.chainIds };
  }
  return { key: 'all', chainIds: parsed.chainIds };
};

const RATE_LIMIT_CFG = {
  rateLimit: {
    max: LEADERBOARD_RATE_LIMIT_MAX,
    timeWindow: LEADERBOARD_RATE_LIMIT_WINDOW,
  },
};

interface RawTipperRow {
  from_address: string;
  tip_count: number | bigint;
  total_amount: string;
}

interface RawRecipientRow {
  to_address: string;
  tip_count: number | bigint;
  total_amount: string;
  host_handle: string | null;
}

interface RawRoomRow {
  slug: string;
  host_handle: string;
  host_smart_address: string;
  tip_count: number | bigint;
  total_amount: string;
}

const toInt = (v: number | bigint): number =>
  typeof v === 'bigint' ? Number(v) : v;

export const leaderboardRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // ---------------------------------------------------------------------------
  // GET /leaderboard/global
  // Registered BEFORE /:slug so Fastify doesn't try to match "global" as a slug.
  // ---------------------------------------------------------------------------
  app.get(
    '/global',
    { config: RATE_LIMIT_CFG },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const q = (request.query || {}) as Record<string, unknown>;
        const limit = parseBoundedInt(q.limit, 1, 100, 10);
        const chainFilter = parseChainIdFilter(q.chainId);
        if (chainFilter.kind === 'error') {
          return handleError(
            reply,
            400,
            t('errors.CHAIN_UNSUPPORTED', request.lang),
            'CHAIN_UNSUPPORTED'
          );
        }
        const scope = buildChainScope(chainFilter);
        const lbMeta: Record<string, unknown> | undefined =
          chainFilter.kind === 'specific' && chainFilter.warning
            ? { warning: chainFilter.warning }
            : undefined;
        const cacheKey = `global:${scope.key}:${limit}`;

        const data = await leaderboardCache.memoize(cacheKey, LEADERBOARD_CACHE_TTL_MS, async () => {
          // Self-tip exclusion via `from_address <> to_address`.
          // Demo-row exclusion via `te.is_demo = false`. The correlated
          // host_handle subquery also filters demo rooms so a demo host can't
          // be attached to a real recipient row by accident. See
          // SECURITY_AUDIT.md W2-HIGH-03.
          // F10: chain scope bound as `int[]` parameter (NEVER concatenated).
          const recipients = await prismaQuery.$queryRaw<RawRecipientRow[]>(Prisma.sql`
            SELECT te.to_address                        AS to_address,
                   COUNT(*)::int                       AS tip_count,
                   SUM(te.amount::numeric)::text       AS total_amount,
                   (SELECT host_handle FROM rooms r
                     WHERE r.host_smart_address = te.to_address
                       AND r.deleted_at IS NULL
                       AND r.is_demo = false
                     ORDER BY r.created_at DESC
                     LIMIT 1)                          AS host_handle
              FROM tip_events te
             WHERE te.from_address <> te.to_address
               AND te.is_demo = false
               AND te.chain_id = ANY(${scope.chainIds}::int[])
             GROUP BY te.to_address
             ORDER BY SUM(te.amount::numeric) DESC
             LIMIT ${limit}
          `);

          const tippers = await prismaQuery.$queryRaw<RawTipperRow[]>(Prisma.sql`
            SELECT te.from_address               AS from_address,
                   COUNT(*)::int                AS tip_count,
                   SUM(te.amount::numeric)::text AS total_amount
              FROM tip_events te
             WHERE te.from_address <> te.to_address
               AND te.is_demo = false
               AND te.chain_id = ANY(${scope.chainIds}::int[])
             GROUP BY te.from_address
             ORDER BY SUM(te.amount::numeric) DESC
             LIMIT ${limit}
          `);

          return {
            generatedAt: new Date().toISOString(),
            cacheTtlSeconds: Math.floor(LEADERBOARD_CACHE_TTL_MS / 1000),
            topRecipients: recipients.map((r) => ({
              toAddress: shortenAddress(r.to_address),
              hostHandle: r.host_handle,
              tipCount: toInt(r.tip_count),
              totalAmount: r.total_amount,
              totalAmountFormatted: formatUsdt(r.total_amount),
            })),
            topTippers: tippers.map((r) => ({
              fromAddress: shortenAddress(r.from_address),
              tipCount: toInt(r.tip_count),
              totalAmount: r.total_amount,
              totalAmountFormatted: formatUsdt(r.total_amount),
            })),
          };
        });

        return reply.code(200).send({
          success: true,
          error: null,
          data: lbMeta ? { ...(data as Record<string, unknown>), meta: lbMeta } : data,
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // GET /leaderboard/global/match/:matchId
  // ---------------------------------------------------------------------------
  app.get(
    '/global/match/:matchId',
    { config: RATE_LIMIT_CFG },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { matchId } = request.params as { matchId: string };
        if (!isValidCuid(matchId)) {
          return handleError(reply, 400, 'Invalid matchId', 'VALIDATION_ERROR');
        }
        const q = (request.query || {}) as Record<string, unknown>;
        const limit = parseBoundedInt(q.limit, 1, 100, 10);
        const chainFilter = parseChainIdFilter(q.chainId);
        if (chainFilter.kind === 'error') {
          return handleError(
            reply,
            400,
            t('errors.CHAIN_UNSUPPORTED', request.lang),
            'CHAIN_UNSUPPORTED'
          );
        }
        const scope = buildChainScope(chainFilter);
        const lbMeta: Record<string, unknown> | undefined =
          chainFilter.kind === 'specific' && chainFilter.warning
            ? { warning: chainFilter.warning }
            : undefined;
        const cacheKey = `match:${matchId}:${scope.key}:${limit}`;

        const data = await leaderboardCache.memoize(cacheKey, LEADERBOARD_CACHE_TTL_MS, async () => {
          const match = await prismaQuery.match.findUnique({
            where: { id: matchId },
            select: { id: true },
          });
          if (!match) return null;

          // Exclude demo rooms AND demo tips. Both filters needed because the
          // LEFT JOIN could otherwise include a non-demo room with demo tips,
          // or count demo rooms even if no demo tips exist. See W2-HIGH-03.
          // F10: chain scope is applied on the join condition so we still
          // surface rooms with zero tips on the requested chain rather than
          // dropping them.
          const rows = await prismaQuery.$queryRaw<RawRoomRow[]>(Prisma.sql`
            SELECT r.slug                          AS slug,
                   r.host_handle                  AS host_handle,
                   r.host_smart_address           AS host_smart_address,
                   COUNT(te.id)::int              AS tip_count,
                   COALESCE(SUM(te.amount::numeric), 0)::text AS total_amount
              FROM rooms r
              LEFT JOIN tip_events te
                ON te.room_id = r.id
               AND te.from_address <> te.to_address
               AND te.is_demo = false
               AND te.chain_id = ANY(${scope.chainIds}::int[])
             WHERE r.match_id = ${matchId}
               AND r.deleted_at IS NULL
               AND r.is_demo = false
             GROUP BY r.slug, r.host_handle, r.host_smart_address
             ORDER BY COALESCE(SUM(te.amount::numeric), 0) DESC
             LIMIT ${limit}
          `);

          return {
            matchId,
            generatedAt: new Date().toISOString(),
            cacheTtlSeconds: Math.floor(LEADERBOARD_CACHE_TTL_MS / 1000),
            topRooms: rows.map((r) => ({
              slug: r.slug,
              hostHandle: r.host_handle,
              hostSmartAddress: shortenAddress(r.host_smart_address),
              tipCount: toInt(r.tip_count),
              totalAmount: r.total_amount,
              totalAmountFormatted: formatUsdt(r.total_amount),
            })),
          };
        });

        if (!data) return handleNotFoundError(reply, 'Match');
        return reply.code(200).send({
          success: true,
          error: null,
          data: lbMeta ? { ...(data as Record<string, unknown>), meta: lbMeta } : data,
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // GET /leaderboard/:slug
  // ---------------------------------------------------------------------------
  app.get(
    '/:slug',
    { config: RATE_LIMIT_CFG },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { slug } = request.params as { slug: string };
        if (!isValidSlug(slug)) {
          return handleError(reply, 400, 'Invalid slug', 'VALIDATION_ERROR');
        }
        const q = (request.query || {}) as Record<string, unknown>;
        const limit = parseBoundedInt(q.limit, 1, 100, 10);
        const chainFilter = parseChainIdFilter(q.chainId);
        if (chainFilter.kind === 'error') {
          return handleError(
            reply,
            400,
            t('errors.CHAIN_UNSUPPORTED', request.lang),
            'CHAIN_UNSUPPORTED'
          );
        }
        const scope = buildChainScope(chainFilter);
        const lbMeta: Record<string, unknown> | undefined =
          chainFilter.kind === 'specific' && chainFilter.warning
            ? { warning: chainFilter.warning }
            : undefined;
        const cacheKey = `slug:${slug}:${scope.key}:${limit}`;

        const data = await leaderboardCache.memoize(cacheKey, LEADERBOARD_CACHE_TTL_MS, async () => {
          const room = await prismaQuery.room.findUnique({
            where: { slug },
            select: { id: true, hostHandle: true, deletedAt: true },
          });
          if (!room || room.deletedAt) return null;

          const rows = await prismaQuery.$queryRaw<RawTipperRow[]>(Prisma.sql`
            SELECT te.from_address               AS from_address,
                   COUNT(*)::int                AS tip_count,
                   SUM(te.amount::numeric)::text AS total_amount
              FROM tip_events te
             WHERE te.room_id = ${room.id}
               AND te.from_address <> te.to_address
               AND te.is_demo = false
               AND te.chain_id = ANY(${scope.chainIds}::int[])
             GROUP BY te.from_address
             ORDER BY SUM(te.amount::numeric) DESC
             LIMIT ${limit}
          `);

          return {
            slug,
            hostHandle: room.hostHandle,
            generatedAt: new Date().toISOString(),
            cacheTtlSeconds: Math.floor(LEADERBOARD_CACHE_TTL_MS / 1000),
            topTippers: rows.map((r) => ({
              fromAddress: shortenAddress(r.from_address),
              tipCount: toInt(r.tip_count),
              totalAmount: r.total_amount,
              totalAmountFormatted: formatUsdt(r.total_amount),
            })),
          };
        });

        if (!data) return handleNotFoundError(reply, 'Room');
        return reply.code(200).send({
          success: true,
          error: null,
          data: lbMeta ? { ...(data as Record<string, unknown>), meta: lbMeta } : data,
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
