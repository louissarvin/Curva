import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { handleError, handleNotFoundError, handleServerError } from '../utils/errorHandler.ts';
import {
  isValidMatchStage,
  isValidMatchStatus,
  isValidIso8601,
  parseBoundedInt,
} from '../utils/curvaValidators.ts';
import { t, DEFAULT_LANG, type Lang } from '../lib/i18n/index.ts';

const TEAM_SELECT = {
  id: true,
  code: true,
  name: true,
  flagUrl: true,
  groupLabel: true,
} as const;

interface MatchRow {
  id: string;
  externalId: number;
  kickoffUtc: Date;
  stage: string;
  status: string;
  groupLabel: string | null;
  homeScore: number | null;
  awayScore: number | null;
  venue: string | null;
  homeTeam: { id: string; code: string; name: string; flagUrl: string | null; groupLabel: string | null };
  awayTeam: { id: string; code: string; name: string; flagUrl: string | null; groupLabel: string | null };
}

const buildMatchView = (m: MatchRow, lang: Lang = DEFAULT_LANG) => ({
  id: m.id,
  externalId: m.externalId,
  kickoffUtc: m.kickoffUtc.toISOString(),
  stage: m.stage,
  status: m.status,
  // F9: translated label; the raw `status` enum stays for programmatic consumers.
  statusLabel: t(`matches.status.${m.status}`, lang),
  groupLabel: m.groupLabel,
  homeScore: m.homeScore,
  awayScore: m.awayScore,
  venue: m.venue,
  homeTeam: m.homeTeam,
  awayTeam: m.awayTeam,
});

export const matchRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // GET /matches
  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const q = (request.query || {}) as Record<string, unknown>;
      const stage = typeof q.stage === 'string' ? q.stage : undefined;
      const status = typeof q.status === 'string' ? q.status : undefined;
      const from = typeof q.from === 'string' ? q.from : undefined;
      const to = typeof q.to === 'string' ? q.to : undefined;
      const limit = parseBoundedInt(q.limit, 1, 200, 100);
      const offset = parseBoundedInt(q.offset, 0, 100000, 0);

      if (stage !== undefined && !isValidMatchStage(stage)) {
        return handleError(reply, 400, 'Invalid stage', 'VALIDATION_ERROR');
      }
      if (status !== undefined && !isValidMatchStatus(status)) {
        return handleError(reply, 400, 'Invalid status', 'VALIDATION_ERROR');
      }
      if (from !== undefined && !isValidIso8601(from)) {
        return handleError(reply, 400, 'Invalid `from` (must be ISO 8601)', 'VALIDATION_ERROR');
      }
      if (to !== undefined && !isValidIso8601(to)) {
        return handleError(reply, 400, 'Invalid `to` (must be ISO 8601)', 'VALIDATION_ERROR');
      }

      const where: Record<string, unknown> = {};
      if (stage) where.stage = stage;
      if (status) where.status = status;
      if (from || to) {
        where.kickoffUtc = {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        };
      }

      const [matches, total] = await Promise.all([
        prismaQuery.match.findMany({
          where,
          orderBy: { kickoffUtc: 'asc' },
          take: limit,
          skip: offset,
          include: {
            homeTeam: { select: TEAM_SELECT },
            awayTeam: { select: TEAM_SELECT },
          },
        }),
        prismaQuery.match.count({ where }),
      ]);

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          matches: matches.map((m) => buildMatchView(m, request.lang)),
          pagination: { limit, offset, total },
        },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  // GET /matches/today
  app.get('/today', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const now = new Date();
      const from = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const to = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const matches = await prismaQuery.match.findMany({
        where: { kickoffUtc: { gte: from, lte: to } },
        orderBy: { kickoffUtc: 'asc' },
        include: {
          homeTeam: { select: TEAM_SELECT },
          awayTeam: { select: TEAM_SELECT },
        },
      });

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          matches: matches.map((m) => buildMatchView(m, request.lang)),
          pagination: { limit: matches.length, offset: 0, total: matches.length },
        },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  // GET /matches/:id  (accepts either cuid id or numeric externalId)
  app.get('/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      if (!id || typeof id !== 'string' || id.length > 64) {
        return handleError(reply, 400, 'Invalid id', 'VALIDATION_ERROR');
      }

      const asNumber = /^[0-9]+$/.test(id) ? Number(id) : null;
      const match = asNumber !== null
        ? await prismaQuery.match.findUnique({
            where: { externalId: asNumber },
            include: { homeTeam: { select: TEAM_SELECT }, awayTeam: { select: TEAM_SELECT } },
          })
        : await prismaQuery.match.findUnique({
            where: { id },
            include: { homeTeam: { select: TEAM_SELECT }, awayTeam: { select: TEAM_SELECT } },
          });

      if (!match) return handleNotFoundError(reply, 'Match');

      return reply.code(200).send({
        success: true,
        error: null,
        data: { match: buildMatchView(match, request.lang) },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  done();
};
