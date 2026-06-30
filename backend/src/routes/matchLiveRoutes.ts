/**
 * GET /matches/:id/live (F7 / ARCHITECTURE.md Section 20).
 *
 * Returns the latest cached live snapshot for a match: status + score +
 * recent goal log. Designed to be safe to call even when the live data
 * feature is disabled — in that case `liveDataEnabled: false` and `goals`
 * is empty but the route still returns 200 with the DB row's persisted
 * score.
 *
 * Rate-limit: 60/min/IP (configurable via LIVE_MATCH_RATE_LIMIT_*).
 *
 * Mounted at `/matches` prefix so the final URL is `GET /matches/:id/live`.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import {
  handleError,
  handleNotFoundError,
  handleServerError,
} from '../utils/errorHandler.ts';
import { get as getGoalLog } from '../lib/liveMatch/goalLog.ts';
import { t } from '../lib/i18n/index.ts';
import {
  FOOTBALL_DATA_API_KEY,
  LIVE_MATCH_RATE_LIMIT_MAX,
  LIVE_MATCH_RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';

export const matchLiveRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/:id/live',
    {
      config: {
        rateLimit: {
          max: LIVE_MATCH_RATE_LIMIT_MAX,
          timeWindow: LIVE_MATCH_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        if (!id || typeof id !== 'string' || id.length > 64) {
          return handleError(reply, 400, 'Invalid id', 'VALIDATION_ERROR');
        }

        // Accept either cuid id or numeric externalId (consistent with
        // matchRoutes /:id behaviour).
        const asNumber = /^[0-9]+$/.test(id) ? Number(id) : null;
        const match = asNumber !== null
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

        if (!match) return handleNotFoundError(reply, 'Match');

        const liveDataEnabled = Boolean(FOOTBALL_DATA_API_KEY);
        // Without an API key the goal log will always be empty by construction,
        // but we still return it as [] for a stable contract.
        const goals = liveDataEnabled
          ? getGoalLog(match.id).map((g) => ({
              minute: g.minute,
              scorer: g.scorer,
              team: g.team,
              homeScoreAfter: g.homeScoreAfter,
              awayScoreAfter: g.awayScoreAfter,
            }))
          : [];

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            matchId: match.id,
            externalId: match.externalId ?? null,
            status: match.status,
            statusLabel: t(`matches.status.${match.status}`, request.lang),
            currentMinute: liveDataEnabled ? match.currentMinute : null,
            homeScore: match.homeScore,
            awayScore: match.awayScore,
            lastSyncedAt:
              liveDataEnabled && match.lastSyncedAt
                ? match.lastSyncedAt.toISOString()
                : null,
            liveDataEnabled,
            goals,
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
