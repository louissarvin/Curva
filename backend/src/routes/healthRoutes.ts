import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { seederSupervisor } from '../lib/pears/seeder.ts';
import { handleServerError } from '../utils/errorHandler.ts';
import { shortenAddress } from '../utils/miscUtils.ts';
import { getAllConfiguredChains, getEnabledChains } from '../lib/evm/chains.ts';
import { getProviderHealth } from '../lib/evm/provider.ts';
import {
  getFacilitatorHealth,
  getSponsorAddress,
  isFacilitatorEnabled,
} from '../lib/evm/facilitator.ts';
import {
  HEALTH_RATE_LIMIT_MAX,
  HEALTH_RATE_LIMIT_WINDOW,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_USDT_ADDRESS,
  SERVICE_STARTED_AT,
  SERVICE_VERSION,
} from '../config/main-config.ts';

// Public /metrics/live is unauthenticated. Mask user-identifying fields so an
// observer cannot scrape host handles, full tip addresses, or tx hashes from
// the demo dashboard. See SECURITY_AUDIT.md HIGH-04.
const maskHostHandle = (h: string): string => {
  if (h.length <= 3) return h.slice(0, 1) + '***';
  return h.slice(0, 3) + '***';
};

const TEAM_SELECT = { code: true, name: true, flagUrl: true } as const;

const pingDb = async (): Promise<{ ok: boolean; latencyMs: number; error?: string }> => {
  const start = Date.now();
  try {
    await prismaQuery.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: (err as Error)?.message };
  }
};

export const healthRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  // GET /health
  // Per-route rate limit (SECURITY_AUDIT MED-04). Endpoint stays unauthenticated
  // so external monitoring / judges can smoke-test the deploy, but redaction +
  // throttling keep scrapers at bay. @fastify/rate-limit is registered globally
  // OFF in index.ts, so `config.rateLimit` opts THIS route in explicitly.
  app.get('/', {
    config: {
      rateLimit: { max: HEALTH_RATE_LIMIT_MAX, timeWindow: HEALTH_RATE_LIMIT_WINDOW },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const dbResult = await pingDb();

    let indexerInfo: { ok: boolean; lastBlock: number | null; lagSeconds: number | null } = {
      ok: false,
      lastBlock: null,
      lagSeconds: null,
    };
    let catalogInfo: { ok: boolean; lastSyncAt: string | null; matchCount: number } = {
      ok: false,
      lastSyncAt: null,
      matchCount: 0,
    };

    // F10: per-chain block, populated below from the provider health map +
    // IndexerCursor rows. The legacy single-object `indexer` field still
    // tracks Sepolia for one release window so existing clients keep working.
    const chains: Record<string, { healthy: boolean | null; lastBlockNumber: number | null; lagSeconds: number | null; enabled: boolean }> = {};

    if (dbResult.ok) {
      try {
        const cursor = await prismaQuery.indexerCursor.findUnique({
          where: { chainId_tokenAddress: { chainId: SEPOLIA_CHAIN_ID, tokenAddress: SEPOLIA_USDT_ADDRESS } },
        });
        indexerInfo = {
          ok: !!cursor,
          lastBlock: cursor?.lastBlockNumber ?? null,
          lagSeconds: cursor?.updatedAt ? Math.floor((Date.now() - cursor.updatedAt.getTime()) / 1000) : null,
        };
      } catch {
        /* ignore */
      }
      // F10: assemble per-chain rollup. Disabled chains report null health.
      try {
        const enabledIds = new Set(getEnabledChains().map((c) => c.chainId));
        for (const c of getAllConfiguredChains()) {
          if (!enabledIds.has(c.chainId)) {
            chains[String(c.chainId)] = {
              healthy: null,
              lastBlockNumber: null,
              lagSeconds: null,
              enabled: false,
            };
            continue;
          }
          const h = getProviderHealth(c.chainId);
          chains[String(c.chainId)] = {
            healthy: h.lagSeconds === null ? null : h.healthy,
            lastBlockNumber: h.lastBlockNumber,
            lagSeconds: h.lagSeconds,
            enabled: true,
          };
        }
      } catch {
        /* ignore */
      }
      try {
        const sync = await prismaQuery.catalogSync.findFirst({ orderBy: { createdAt: 'desc' } });
        const matchCount = await prismaQuery.match.count();
        catalogInfo = {
          ok: !!sync && sync.status === 'ok',
          lastSyncAt: sync?.createdAt.toISOString() ?? null,
          matchCount,
        };
      } catch {
        /* ignore */
      }
    }

    const seederInfo = {
      ok: true, // seeder is opt-in; "ok" reflects "did not error", not "running"
      enabled: seederSupervisor.isEnabled(),
      activeRooms: seederSupervisor.getActiveRoomCount(),
      totalPeers: seederSupervisor.getTotalPeers(),
    };

    // Facilitator snapshot — surfaced on the top-level /health so judges (and
    // the pre-flight curl in the README) can confirm the sponsor wallet is
    // funded without hitting the disabled-503 on /wdk/relay/health. When the
    // facilitator is off we return `enabled: false` and null the address so
    // the wallet is never leaked on a mis-configured deploy. When on, we
    // shorten the sponsor address for the same reason /metrics/live does.
    // lastSubmittedTxHash comes from FacilitatorTx and is best-effort — a DB
    // hiccup returns null rather than 500ing the health check.
    let facilitatorSection: {
      enabled: boolean;
      sponsorAddress: string | null;
      balances: Array<{
        chainId: number;
        chainName: string;
        balanceEth: string;
        healthy: boolean;
      }>;
      lastSubmittedTxHash: string | null;
    } = {
      enabled: isFacilitatorEnabled(),
      sponsorAddress: null,
      balances: [],
      lastSubmittedTxHash: null,
    };
    if (isFacilitatorEnabled()) {
      try {
        const health = getFacilitatorHealth();
        const sponsor = getSponsorAddress();
        let lastSubmitted: string | null = null;
        try {
          const row = await prismaQuery.facilitatorTx.findFirst({
            orderBy: { submittedAt: 'desc' },
            select: { txHash: true },
          });
          lastSubmitted = row?.txHash ?? null;
        } catch {
          /* keep null */
        }
        facilitatorSection = {
          enabled: true,
          sponsorAddress: sponsor ? shortenAddress(sponsor) : null,
          balances: health.balances.map((b) => ({
            chainId: b.chainId,
            chainName: b.chainName,
            balanceEth: b.balanceEth,
            healthy: b.healthy,
          })),
          // SECURITY_AUDIT MED-04: shorten to match the /metrics/live and
          // /activity redaction contract. Unauthenticated /health must never
          // leak full 66-char tx hashes.
          lastSubmittedTxHash: lastSubmitted
            ? shortenAddress(lastSubmitted, 10, 6)
            : null,
        };
      } catch {
        /* keep disabled shape */
      }
    }

    const status = !dbResult.ok
      ? 'down'
      : !catalogInfo.ok || !indexerInfo.ok
      ? 'degraded'
      : 'ok';

    return reply.code(dbResult.ok ? 200 : 503).send({
      success: true,
      error: null,
      data: {
        status,
        version: SERVICE_VERSION,
        uptimeSeconds: Math.floor((Date.now() - SERVICE_STARTED_AT) / 1000),
        db: dbResult,
        seeder: seederInfo,
        indexer: indexerInfo,
        // F10: per-chain rollup (additive — old clients keep reading `indexer`).
        chains,
        catalog: catalogInfo,
        // F11: facilitator snapshot for pre-flight curl. See comment above.
        facilitator: facilitatorSection,
      },
    });
  });

  // GET /health/db
  app.get('/db', {
    config: {
      rateLimit: { max: HEALTH_RATE_LIMIT_MAX, timeWindow: HEALTH_RATE_LIMIT_WINDOW },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = await pingDb();
    return reply.code(result.ok ? 200 : 503).send({
      success: result.ok,
      error: result.ok ? null : { code: 'DB_DOWN', message: result.error ?? 'unknown' },
      data: result,
    });
  });

  // GET /metrics/live  (note: registered under /metrics prefix in index.ts)
  //
  // Demo isolation policy (SECURITY_AUDIT.md W2-HIGH-03):
  //   Demo rows (isDemo=true) are filtered out of EVERY metric on this public
  //   endpoint — counters, last-tip list, and last-room list. Demo data exists
  //   only to power the demo room display and the /demo/seed response payload;
  //   it must never leak into Curva's public telemetry surface.
  app.get('/live', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const now = new Date();
      const todayWindowStart = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const todayWindowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const [activeRooms, indexedTips, todayMatchCount, lastTips, lastRooms, cursor] =
        await Promise.all([
          prismaQuery.room.count({
            where: { deletedAt: null, expiresAt: { gt: now }, isDemo: false },
          }),
          prismaQuery.tipEvent.count({ where: { isDemo: false } }),
          prismaQuery.match.count({ where: { kickoffUtc: { gte: todayWindowStart, lte: todayWindowEnd } } }),
          prismaQuery.tipEvent.findMany({
            where: { isDemo: false },
            orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
            take: 5,
            select: {
              id: true,
              amount: true,
              fromAddress: true,
              toAddress: true,
              txHash: true,
              blockNumber: true,
              blockTime: true,
            },
          }),
          prismaQuery.room.findMany({
            where: { deletedAt: null, isDemo: false },
            orderBy: { createdAt: 'desc' },
            take: 5,
            include: {
              match: {
                select: {
                  id: true,
                  stage: true,
                  kickoffUtc: true,
                  homeTeam: { select: TEAM_SELECT },
                  awayTeam: { select: TEAM_SELECT },
                },
              },
            },
          }),
          prismaQuery.indexerCursor.findUnique({
            where: {
              chainId_tokenAddress: { chainId: SEPOLIA_CHAIN_ID, tokenAddress: SEPOLIA_USDT_ADDRESS },
            },
          }),
        ]);

      return reply.code(200).send({
        success: true,
        error: null,
        data: {
          activeRooms,
          indexedTips,
          lastBlock: cursor?.lastBlockNumber ?? null,
          peerCountTotal: seederSupervisor.getTotalPeers(),
          todayMatchCount,
          lastTips: lastTips.map((t) => ({
            id: t.id,
            amount: t.amount,
            // Redacted: full addresses + tx hashes leak PII to unauthenticated callers.
            fromAddress: shortenAddress(t.fromAddress),
            toAddress: shortenAddress(t.toAddress),
            txHash: shortenAddress(t.txHash, 10, 6),
            blockNumber: t.blockNumber,
            blockTime: t.blockTime.toISOString(),
          })),
          lastRooms: lastRooms.map((r) => ({
            slug: r.slug,
            // Redacted: avoid exposing hosts who did not opt into directory listing.
            hostHandle: maskHostHandle(r.hostHandle),
            createdAt: r.createdAt.toISOString(),
            match: r.match
              ? {
                  id: r.match.id,
                  stage: r.match.stage,
                  kickoffUtc: r.match.kickoffUtc.toISOString(),
                  homeTeam: r.match.homeTeam,
                  awayTeam: r.match.awayTeam,
                }
              : null,
          })),
        },
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  done();
};
