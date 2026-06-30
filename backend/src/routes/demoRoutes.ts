/**
 * Demo seed endpoint (F5).
 *
 *   POST /demo/seed   — bearer-token gated (Authorization: Bearer ${DEMO_SEED_TOKEN})
 *
 * Per ARCH 19 F5 + ADR-007:
 *   - If DEMO_SEED_TOKEN is unset, the preHandler returns 404 (hide existence).
 *   - If set, the route requires the bearer token AND (for ?reset=true) a
 *     second confirmation header X-Curva-Confirm-Reset: true.
 *   - All scenarios are idempotent. Synthetic tx hashes follow the
 *     "demo-0x<sha256-of-content>" shape so they never collide with real
 *     on-chain hashes. The reset path only deletes rows where
 *     tx_hash LIKE 'demo-%'.
 *
 * Rate limit: 5/min/IP via @fastify/rate-limit (defence in depth alongside
 * the bearer check).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { eventBus } from '../lib/activity/eventBus.ts';
import { shortenAddress } from '../utils/miscUtils.ts';
import { formatUsdt } from '../lib/evm/usdtIndexer.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';
import {
  DEMO_SEED_RATE_LIMIT_MAX,
  DEMO_SEED_RATE_LIMIT_WINDOW,
  DEMO_SEED_TOKEN,
  DEMO_WALLET_NORD_OWNER,
  DEMO_WALLET_NORD_SMART,
  DEMO_WALLET_SUD_OWNER,
  DEMO_WALLET_SUD_SMART,
  IS_PROD,
  ROOM_MATCH_DURATION_HOURS,
  ROOM_POST_MATCH_BUFFER_HOURS,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_USDT_ADDRESS,
} from '../config/main-config.ts';

// =============================================================================
// Scenarios
// =============================================================================

type ScenarioId = 'curva-sud-torino' | 'curva-nord-jakarta' | 'demo-final-day';

interface TipSeed {
  fromAddress: string;
  amount: bigint;
  minutesAgo: number;
}

interface ScenarioConfig {
  id: ScenarioId;
  slug: string;
  hostHandle: string;
  walletKey: 'sud' | 'nord';
  tipSeeds: TipSeed[];
}

// Stable filler tipper addresses (zero-funded; safe to expose as they are
// purely demo identifiers, never used for actual signing).
const DEMO_TIPPERS = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
  '0x4444444444444444444444444444444444444444',
  '0x5555555555555555555555555555555555555555',
];

const buildTipSeeds = (count: number): TipSeed[] => {
  const amounts = [1_000_000n, 5_000_000n, 10_000_000n, 2_500_000n, 7_500_000n];
  return Array.from({ length: count }, (_, i) => ({
    fromAddress: DEMO_TIPPERS[i % DEMO_TIPPERS.length] as string,
    amount: amounts[i % amounts.length] as bigint,
    minutesAgo: (count - i) * 5,
  }));
};

const SCENARIOS: ScenarioConfig[] = [
  {
    id: 'curva-sud-torino',
    slug: 'demo-curva-sud-torino',
    hostHandle: 'Curva Sud Torino',
    walletKey: 'sud',
    tipSeeds: buildTipSeeds(4),
  },
  {
    id: 'curva-nord-jakarta',
    slug: 'demo-curva-nord-jakarta',
    hostHandle: 'Curva Nord Jakarta',
    walletKey: 'nord',
    tipSeeds: buildTipSeeds(5),
  },
  {
    id: 'demo-final-day',
    slug: 'demo-final-day',
    hostHandle: 'Demo Stage',
    walletKey: 'sud',
    tipSeeds: buildTipSeeds(3),
  },
];

const walletFor = (key: 'sud' | 'nord'): { owner?: string; smart?: string } => {
  if (key === 'sud') return { owner: DEMO_WALLET_SUD_OWNER, smart: DEMO_WALLET_SUD_SMART };
  return { owner: DEMO_WALLET_NORD_OWNER, smart: DEMO_WALLET_NORD_SMART };
};

// =============================================================================
// Auth: constant-time bearer comparison
// =============================================================================

const bearerOk = (header: string | undefined, token: string): boolean => {
  if (!header) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

// =============================================================================
// Synthetic tx-hash builder. 64 hex chars after the "demo-0x" prefix so any
// future regex validation can pattern-match cleanly. SHA-256 of (scenario:idx)
// gives idempotent reseed behaviour.
// =============================================================================

const buildDemoTxHash = (scenarioId: string, index: number): string => {
  const digest = createHash('sha256').update(`${scenarioId}:${index}`).digest('hex');
  return `demo-0x${digest}`;
};

// =============================================================================
// Route plugin
// =============================================================================

export const demoRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  if (IS_PROD && DEMO_SEED_TOKEN) {
    console.warn(
      '[Demo] WARN: DEMO_SEED_TOKEN is set in production. Ensure it is rotated post-demo.'
    );
  }

  app.post(
    '/seed',
    {
      config: {
        rateLimit: { max: DEMO_SEED_RATE_LIMIT_MAX, timeWindow: DEMO_SEED_RATE_LIMIT_WINDOW },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // ADR-007: hide the endpoint when the token is unset.
        if (!DEMO_SEED_TOKEN) {
          return handleError(reply, 404, 'Not found', 'NOT_FOUND');
        }
        const authHeader = request.headers['authorization'];
        if (!bearerOk(typeof authHeader === 'string' ? authHeader : undefined, DEMO_SEED_TOKEN)) {
          return handleError(reply, 401, 'Unauthorized', 'UNAUTHORIZED');
        }

        const q = (request.query || {}) as Record<string, unknown>;
        const wantsReset = q.reset === 'true' || q.reset === '1';
        if (wantsReset) {
          const confirm = request.headers['x-curva-confirm-reset'];
          if (confirm !== 'true') {
            return handleError(
              reply,
              400,
              'Reset requested but X-Curva-Confirm-Reset: true header missing',
              'RESET_CONFIRMATION_MISSING'
            );
          }
        }

        const body = (request.body || {}) as { scenarios?: unknown };
        let scenarioIds: ScenarioId[];
        if (body.scenarios === undefined || body.scenarios === null) {
          scenarioIds = SCENARIOS.map((s) => s.id);
        } else if (Array.isArray(body.scenarios)) {
          const allowed = new Set<ScenarioId>(SCENARIOS.map((s) => s.id));
          scenarioIds = body.scenarios.filter(
            (s): s is ScenarioId => typeof s === 'string' && allowed.has(s as ScenarioId)
          );
          if (scenarioIds.length === 0) {
            return handleError(
              reply,
              400,
              'scenarios array contains no valid scenario ids',
              'VALIDATION_ERROR'
            );
          }
        } else {
          return handleError(reply, 400, 'scenarios must be an array', 'VALIDATION_ERROR');
        }

        // Determine the closest scheduled match to bind scenarios to.
        const now = new Date();
        const matchDurationMs =
          (ROOM_MATCH_DURATION_HOURS + ROOM_POST_MATCH_BUFFER_HOURS) * 3_600_000;
        const upcomingMatch = await prismaQuery.match
          .findFirst({
            where: { kickoffUtc: { gte: now } },
            orderBy: { kickoffUtc: 'asc' },
            select: { id: true, kickoffUtc: true },
          })
          .catch(() => null);
        const fallbackMatch = upcomingMatch
          ? null
          : await prismaQuery.match
              .findFirst({ orderBy: { kickoffUtc: 'asc' }, select: { id: true, kickoffUtc: true } })
              .catch(() => null);
        const matchForScenario = upcomingMatch ?? fallbackMatch;

        // Reset path: soft-delete only rooms flagged as demo, hard-delete only
        // tip rows flagged as demo. This is surgical — a user-registered room
        // with slug `demo-foo` (now allowed since the namespace is no longer
        // gated by prefix) is never collateral damage. See SECURITY_AUDIT.md
        // W2-HIGH-03.
        if (wantsReset) {
          const demoRooms = await prismaQuery.room.findMany({
            where: { isDemo: true },
            select: { id: true },
          });
          const demoRoomIds = demoRooms.map((r) => r.id);
          if (demoRoomIds.length > 0) {
            await prismaQuery.room.updateMany({
              where: { id: { in: demoRoomIds }, deletedAt: null },
              data: { deletedAt: now },
            });
            await prismaQuery.tipEvent.deleteMany({
              where: { isDemo: true, roomId: { in: demoRoomIds } },
            });
          }
        }

        const created: Array<{ scenarioId: ScenarioId; slug: string; roomId: string; tipsSeeded: number }> = [];
        const skipped: Array<{ scenarioId: ScenarioId; reason: string }> = [];

        for (const sid of scenarioIds) {
          const cfg = SCENARIOS.find((s) => s.id === sid);
          if (!cfg) {
            skipped.push({ scenarioId: sid, reason: 'unknown scenario' });
            continue;
          }
          const wallet = walletFor(cfg.walletKey);
          if (!wallet.owner || !wallet.smart) {
            skipped.push({
              scenarioId: sid,
              reason: `missing env DEMO_WALLET_${cfg.walletKey.toUpperCase()}_OWNER / _SMART`,
            });
            continue;
          }
          if (!matchForScenario) {
            skipped.push({ scenarioId: sid, reason: 'no Match rows in DB; run catalog sync first' });
            continue;
          }

          const expiresAt = new Date(matchForScenario.kickoffUtc.getTime() + matchDurationMs);
          const room = await prismaQuery.room.upsert({
            where: { slug: cfg.slug },
            create: {
              slug: cfg.slug,
              matchId: matchForScenario.id,
              hostHandle: cfg.hostHandle,
              hostSmartAddress: wallet.smart,
              hostOwnerAddress: wallet.owner,
              pearLink: `pear://curva?room=${cfg.slug}`,
              expiresAt,
              isAutoWarmed: false,
              // Tag demo rows so leaderboard/metrics can exclude them.
              isDemo: true,
            },
            update: {
              deletedAt: null,
              hostHandle: cfg.hostHandle,
              hostSmartAddress: wallet.smart,
              hostOwnerAddress: wallet.owner,
              expiresAt,
              matchId: matchForScenario.id,
              // Always re-flag on update in case the row was created pre-flag.
              isDemo: true,
            },
          });

          // Publish room.created event.
          try {
            eventBus.publish('room.created', {
              slug: room.slug,
              matchId: room.matchId,
              hostHandle: cfg.hostHandle.slice(0, 3) + '***',
              isAutoWarmed: false,
            });
          } catch {
            /* swallow */
          }

          let tipsSeeded = 0;
          for (let i = 0; i < cfg.tipSeeds.length; i++) {
            const seed = cfg.tipSeeds[i] as TipSeed;
            const txHash = buildDemoTxHash(cfg.id, i);
            const blockTime = new Date(now.getTime() - seed.minutesAgo * 60_000);
            const blockNumber = Math.floor(blockTime.getTime() / 12_000);
            try {
              await prismaQuery.tipEvent.upsert({
                where: { txHash_logIndex: { txHash, logIndex: 0 } },
                create: {
                  chainId: SEPOLIA_CHAIN_ID,
                  tokenAddress: SEPOLIA_USDT_ADDRESS,
                  fromAddress: seed.fromAddress.toLowerCase(),
                  toAddress: wallet.smart,
                  amount: seed.amount.toString(),
                  txHash,
                  logIndex: 0,
                  blockNumber,
                  blockTime,
                  roomId: room.id,
                  // Tag demo tips so leaderboard SQL filters them out.
                  isDemo: true,
                },
                update: { roomId: room.id, blockTime, blockNumber, isDemo: true },
              });
              tipsSeeded += 1;
              try {
                eventBus.publish('tip.confirmed', {
                  txHash,
                  fromAddress: shortenAddress(seed.fromAddress),
                  toAddress: shortenAddress(wallet.smart),
                  amount: seed.amount.toString(),
                  amountFormatted: formatUsdt(seed.amount.toString()),
                  blockNumber,
                  blockTime: blockTime.toISOString(),
                  roomSlug: room.slug,
                });
              } catch {
                /* swallow */
              }
            } catch (err) {
              console.warn(
                `[Demo] tip seed ${cfg.id}#${i} failed:`,
                (err as Error)?.message || err
              );
            }
          }

          created.push({ scenarioId: sid, slug: room.slug, roomId: room.id, tipsSeeded });
        }

        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            reset: wantsReset,
            scenarios: scenarioIds,
            created,
            skipped,
            wallets: {
              sud: {
                owner: DEMO_WALLET_SUD_OWNER ? shortenAddress(DEMO_WALLET_SUD_OWNER) : null,
                smart: DEMO_WALLET_SUD_SMART ? shortenAddress(DEMO_WALLET_SUD_SMART) : null,
              },
              nord: {
                owner: DEMO_WALLET_NORD_OWNER ? shortenAddress(DEMO_WALLET_NORD_OWNER) : null,
                smart: DEMO_WALLET_NORD_SMART ? shortenAddress(DEMO_WALLET_NORD_SMART) : null,
              },
            },
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
