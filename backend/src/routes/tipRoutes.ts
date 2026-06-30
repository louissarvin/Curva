import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
} from '../utils/errorHandler.ts';
import { isValidEvmAddress, isValidSlug, normalizeAddress, parseBoundedInt } from '../utils/curvaValidators.ts';
import { formatUsdt } from '../lib/evm/usdtIndexer.ts';
import { USDT_DECIMALS } from '../config/main-config.ts';
import { parseChainIdFilter } from '../lib/evm/chainFilter.ts';
import { t } from '../lib/i18n/index.ts';
import { Prisma } from '../../prisma/generated/client.js';

const TEAM_SELECT = { id: true, code: true, name: true, flagUrl: true } as const;

/**
 * Cursor format: `<blockNumber>_<logIndex>`. Encoded as a single string so the
 * client doesn't need to know the schema. Decoded server-side.
 */
const parseCursor = (raw: unknown): { block: number; logIndex: number } | null => {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const [a, b] = raw.split('_');
  if (!a || !b) return null;
  const block = Number(a);
  const logIndex = Number(b);
  if (!Number.isInteger(block) || !Number.isInteger(logIndex) || block < 0 || logIndex < 0) {
    return null;
  }
  return { block, logIndex };
};

const encodeCursor = (block: number, logIndex: number): string => `${block}_${logIndex}`;

interface TipRow {
  id: string;
  chainId: number;
  tokenAddress: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: Date;
  roomId: string | null;
}

interface TipRoomInput {
  slug: string;
  hostHandle: string;
  match?: { id: string; kickoffUtc: Date | string; stage: string } | null;
}

const buildTipView = (t: TipRow, room?: TipRoomInput | null) => {
  let matchView: { id: string; kickoffUtc: string; stage: string } | null = null;
  if (room?.match) {
    const k = room.match.kickoffUtc;
    matchView = {
      id: room.match.id,
      kickoffUtc: typeof k === 'string' ? k : k.toISOString(),
      stage: room.match.stage,
    };
  }
  return {
    id: t.id,
    chainId: t.chainId,
    tokenAddress: t.tokenAddress,
    fromAddress: t.fromAddress,
    toAddress: t.toAddress,
    amount: t.amount,
    amountFormatted: formatUsdt(t.amount),
    txHash: t.txHash,
    logIndex: t.logIndex,
    blockNumber: t.blockNumber,
    blockTime: t.blockTime.toISOString(),
    room: room
      ? {
          slug: room.slug,
          hostHandle: room.hostHandle,
          match: matchView,
        }
      : null,
  };
};

export const tipRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // GET /tips/:address  (cursor pagination)
  app.get('/:address', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { address } = request.params as { address: string };
      if (!isValidEvmAddress(address)) {
        return handleError(reply, 400, 'Invalid EVM address', 'VALIDATION_ERROR');
      }
      const toAddress = normalizeAddress(address);
      const q = (request.query || {}) as Record<string, unknown>;
      const limit = parseBoundedInt(q.limit, 1, 100, 50);
      const cursor = parseCursor(q.cursor);
      const chainFilter = parseChainIdFilter(q.chainId);
      if (chainFilter.kind === 'error') {
        return handleError(
          reply,
          400,
          t('errors.CHAIN_UNSUPPORTED', request.lang),
          'CHAIN_UNSUPPORTED'
        );
      }

      // (block, logIndex) < (cursor.block, cursor.logIndex). Postgres tuple comparison
      // via Prisma is awkward, so we emulate: block < cursor.block OR (block = cursor.block AND logIndex < cursor.logIndex)
      const where: Record<string, unknown> = { toAddress };
      if (chainFilter.kind === 'specific') {
        // ADR-009: a known-but-disabled chain still queries with its predicate
        // (returning an empty result), accompanied by `meta.warning: 'CHAIN_DISABLED'`.
        where.chainId = chainFilter.chainIds[0];
      }
      if (cursor) {
        where.OR = [
          { blockNumber: { lt: cursor.block } },
          { blockNumber: cursor.block, logIndex: { lt: cursor.logIndex } },
        ];
      }

      const tips = await prismaQuery.tipEvent.findMany({
        where,
        orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
        take: limit,
      });

      // Fetch room metadata for the unique roomIds in this batch.
      const roomIds = Array.from(new Set(tips.map((t) => t.roomId).filter((x): x is string => !!x)));
      const rooms = roomIds.length
        ? await prismaQuery.room.findMany({
            where: { id: { in: roomIds } },
            include: { match: { select: { id: true, kickoffUtc: true, stage: true } } },
          })
        : [];
      const roomById = new Map(rooms.map((r) => [r.id, r]));

      const nextCursor =
        tips.length === limit
          ? encodeCursor(tips[tips.length - 1]!.blockNumber, tips[tips.length - 1]!.logIndex)
          : null;

      const meta: Record<string, unknown> | undefined =
        chainFilter.kind === 'specific' && chainFilter.warning
          ? { warning: chainFilter.warning }
          : undefined;

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          tips: tips.map((row) => buildTipView(row, row.roomId ? roomById.get(row.roomId) : null)),
          nextCursor,
          ...(meta ? { meta } : {}),
        },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  // GET /tips/:address/total
  app.get('/:address/total', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { address } = request.params as { address: string };
      if (!isValidEvmAddress(address)) {
        return handleError(reply, 400, 'Invalid EVM address', 'VALIDATION_ERROR');
      }
      const toAddress = normalizeAddress(address);
      const q = (request.query || {}) as Record<string, unknown>;
      const chainFilter = parseChainIdFilter(q.chainId);
      if (chainFilter.kind === 'error') {
        return handleError(
          reply,
          400,
          t('errors.CHAIN_UNSUPPORTED', request.lang),
          'CHAIN_UNSUPPORTED'
        );
      }

      // Aggregate in Postgres rather than loading every row. The amount column
      // is a string of base units (USDT 6 decimals); cast to NUMERIC for SUM
      // and back to TEXT to preserve precision through JSON.
      //
      // Demo rows excluded so the public endpoint is not contaminated by
      // /demo/seed (SECURITY_AUDIT.md W2-HIGH-03).
      //
      // F10: when ?chainId= is omitted we sum across all enabled chains; when
      // provided we filter to that chain (including known-but-disabled chains —
      // those return an empty sum with `meta.warning: 'CHAIN_DISABLED'`). Either
      // way the chain_id column is bound as a parameter — never concatenated.
      // Defensive: an empty enabledIds would cause ANY($1) to match no rows;
      // returning a zeroed total is the correct (and graceful) behaviour.
      const chainIdsParam = chainFilter.chainIds;

      const rows = await prismaQuery.$queryRaw<Array<{ total: string; count: bigint }>>(
        Prisma.sql`
          SELECT
            COALESCE(SUM(CAST(amount AS NUMERIC)), 0)::TEXT AS total,
            COUNT(*)::BIGINT AS count
          FROM tip_events
          WHERE to_address = ${toAddress}
            AND chain_id = ANY(${chainIdsParam}::int[])
            AND is_demo = false
        `
      );

      const row = rows[0];
      const totalStr = row?.total ?? '0';
      const count = row ? Number(row.count) : 0;

      const totalMeta: Record<string, unknown> | undefined =
        chainFilter.kind === 'specific' && chainFilter.warning
          ? { warning: chainFilter.warning }
          : undefined;

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          totalAmount: totalStr,
          count,
          tokenDecimals: USDT_DECIMALS,
          formatted: formatUsdt(totalStr),
          // Echo the chain scope so clients know which chains contributed.
          chainIds: chainIdsParam,
          ...(totalMeta ? { meta: totalMeta } : {}),
        },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  // GET /tips/by-room/:slug
  app.get('/by-room/:slug', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { slug } = request.params as { slug: string };
      if (!isValidSlug(slug)) return handleError(reply, 400, 'Invalid slug', 'VALIDATION_ERROR');

      const room = await prismaQuery.room.findUnique({
        where: { slug },
        include: { match: { select: { id: true, kickoffUtc: true, stage: true, homeTeam: { select: TEAM_SELECT }, awayTeam: { select: TEAM_SELECT } } } },
      });
      if (!room) return handleNotFoundError(reply, 'Room');

      const q = (request.query || {}) as Record<string, unknown>;
      const limit = parseBoundedInt(q.limit, 1, 100, 50);
      const cursor = parseCursor(q.cursor);
      const chainFilter = parseChainIdFilter(q.chainId);
      if (chainFilter.kind === 'error') {
        return handleError(
          reply,
          400,
          t('errors.CHAIN_UNSUPPORTED', request.lang),
          'CHAIN_UNSUPPORTED'
        );
      }

      const where: Record<string, unknown> = { roomId: room.id };
      if (chainFilter.kind === 'specific') {
        where.chainId = chainFilter.chainIds[0];
      }
      if (cursor) {
        where.OR = [
          { blockNumber: { lt: cursor.block } },
          { blockNumber: cursor.block, logIndex: { lt: cursor.logIndex } },
        ];
      }

      const tips = await prismaQuery.tipEvent.findMany({
        where,
        orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
        take: limit,
      });

      const nextCursor =
        tips.length === limit
          ? encodeCursor(tips[tips.length - 1]!.blockNumber, tips[tips.length - 1]!.logIndex)
          : null;

      const roomSummary = {
        slug: room.slug,
        hostHandle: room.hostHandle,
        match: room.match
          ? { id: room.match.id, kickoffUtc: room.match.kickoffUtc.toISOString(), stage: room.match.stage }
          : null,
      };

      const byRoomMeta: Record<string, unknown> | undefined =
        chainFilter.kind === 'specific' && chainFilter.warning
          ? { warning: chainFilter.warning }
          : undefined;

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          room: roomSummary,
          tips: tips.map((row) => buildTipView(row, roomSummary)),
          nextCursor,
          ...(byRoomMeta ? { meta: byRoomMeta } : {}),
        },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  done();
};
