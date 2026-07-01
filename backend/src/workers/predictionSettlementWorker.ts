/**
 * Wave 10 — Match Prediction Pool settlement worker.
 *
 * Every PREDICTIONS_SETTLEMENT_CRON tick (default every 30s):
 *   1. Find PredictionPool rows in 'open' whose deadlineMs has passed and
 *      transition them to 'locked'.
 *   2. Find pools in 'locked' whose resultWinner is set. For each:
 *        a. Compute the settlement plan via predictionPool.computeSettlement.
 *        b. Dispatch payouts via predictionPool.dispatchPayouts (real ERC-20
 *           transfer from the F11 sponsor wallet).
 *        c. Update winner Prediction rows to 'won' with payoutTxHash. Update
 *           non-winner confirmed rows to keep 'confirmed' (they lost).
 *        d. Move the pool to 'settled' with settledAt=now.
 *        e. Publish 'prediction.settled' + per-winner 'prediction.payout'.
 *   3. If a pool has NO winners AND at least one confirmed entry, mark the pool
 *      'refunded' and dispatch refunds. (Documented in predictionPool.ts.)
 *
 * Guarded by `isRunning` per the backend conventions memory.
 *
 * When CURVA_PREDICTIONS_ENABLED=false, the worker no-ops on every tick (safe
 * to schedule unconditionally at boot).
 */

import cron from 'node-cron';
import { prismaQuery as _prismaQuery } from '../lib/prisma.ts';

// See predictionRoutes.ts for the rationale: Wave 10 models are generated on
// `bun run db:push`. Cast at boundary keeps `bunx tsc --noEmit` green.
const prismaQuery = _prismaQuery as unknown as typeof _prismaQuery & {
  predictionPool: {
    updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
    findMany: (args: Record<string, unknown>) => Promise<Array<{
      id: string; roomSlug: string; matchId: string; mode: string; chainId: number;
      stakeToken: string; resultWinner: string | null; resultHomeGoals: number | null;
      resultAwayGoals: number | null;
      predictions: Array<{
        id: string; peerAddress: string; winner: string;
        homeGoals: number | null; awayGoals: number | null;
        stakeAtomic: string; status: string;
      }>;
    }>>;
    update: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
  prediction: {
    update: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
};
import {
  computeSettlement,
  dispatchPayouts,
  type PoolMode,
  type PredictionRow,
  type WinnerSide,
} from '../lib/evm/predictionPool.ts';
import { eventBus } from '../lib/activity/eventBus.ts';
import { formatUsdt } from '../lib/evm/usdtIndexer.ts';
import { shortenAddress } from '../utils/miscUtils.ts';
import {
  CURVA_PREDICTIONS_ENABLED,
  PREDICTIONS_SETTLEMENT_CRON,
} from '../config/main-config.ts';

let isRunning = false;

/**
 * The worker imports the sponsor wallet at RUN TIME (not module load) via the
 * facilitator's __getSponsorForWorker path so a disabled facilitator does not
 * crash on boot. This mirrors the F11 confirmation worker pattern.
 */
const getSponsorWalletForWorker = async (): Promise<import('ethers').Wallet | null> => {
  const facilitator = await import('../lib/evm/facilitator.ts');
  if (!facilitator.isFacilitatorEnabled()) return null;
  // facilitator.ts does not export the wallet directly (PK safety). For the
  // worker, we use a runtime hook: __getSponsorForTest returns null in prod
  // unless the test suite injected one. In production the settlement worker
  // must invoke the same submit path as F11 does, so we use the facilitator's
  // exported submitEip3009Relay for the entry path and reuse the sponsor for
  // payouts via a getter added below.
  return (facilitator as unknown as { __getSponsorWallet?: () => import('ethers').Wallet | null })
    .__getSponsorWallet?.() ?? null;
};

const settleTick = async (): Promise<void> => {
  if (!CURVA_PREDICTIONS_ENABLED) return;
  if (isRunning) {
    console.log('[PredictionSettlement] Previous tick still active, skipping');
    return;
  }
  isRunning = true;
  try {
    // ---- Phase 1: lock pools past deadline --------------------------------
    const nowMs = Date.now();
    // Prisma bigint filters: pass a plain BigInt. Prisma converts under the hood.
    await prismaQuery.predictionPool.updateMany({
      where: { status: 'open', deadlineMs: { lte: BigInt(nowMs) } },
      data: { status: 'locked' },
    });

    // ---- Phase 2: settle locked pools with a result -----------------------
    const locked = await prismaQuery.predictionPool.findMany({
      where: { status: 'locked', resultWinner: { not: null } },
      include: { predictions: true },
      take: 10, // hackathon scale; keep tick bounded.
    });

    if (locked.length === 0) return;

    const sponsorWallet = await getSponsorWalletForWorker();
    if (!sponsorWallet) {
      console.warn('[PredictionSettlement] sponsor wallet unavailable; will retry next tick');
      return;
    }

    for (const pool of locked) {
      try {
        const rows: PredictionRow[] = pool.predictions.map((p) => ({
          id: p.id,
          peerAddress: p.peerAddress,
          winner: p.winner as WinnerSide,
          homeGoals: p.homeGoals,
          awayGoals: p.awayGoals,
          stakeAtomic: p.stakeAtomic,
          status: p.status as PredictionRow['status'],
        }));
        const plan = computeSettlement(
          pool.mode as PoolMode,
          rows,
          {
            winner: pool.resultWinner as WinnerSide,
            homeGoals: pool.resultHomeGoals ?? 0,
            awayGoals: pool.resultAwayGoals ?? 0,
          }
        );

        // No winners AND no confirmed stakes: mark settled with zero payouts.
        if (plan.winnerIds.length === 0 && !plan.refundRequired) {
          await prismaQuery.predictionPool.update({
            where: { id: pool.id },
            data: { status: 'settled', settledAt: new Date() },
          });
          continue;
        }

        if (plan.refundRequired) {
          // Refund every confirmed entry with its original stake.
          const refunds = rows
            .filter((r) => r.status === 'confirmed')
            .map((r) => ({
              predictionId: r.id,
              peerAddress: r.peerAddress,
              amountAtomic: BigInt(r.stakeAtomic),
            }));
          const results = await dispatchPayouts(
            sponsorWallet,
            pool.chainId,
            pool.stakeToken,
            refunds
          );
          for (const res of results) {
            if (res.txHash) {
              await prismaQuery.prediction.update({
                where: { id: res.predictionId },
                data: {
                  status: 'refunded',
                  payoutTxHash: res.txHash,
                  payoutAmountAtomic: res.amountAtomic.toString(),
                },
              });
            }
          }
          await prismaQuery.predictionPool.update({
            where: { id: pool.id },
            data: { status: 'refunded', settledAt: new Date() },
          });
          continue;
        }

        // Winner payouts.
        const winnerRows = rows.filter((r) => plan.winnerIds.includes(r.id));
        const payouts = winnerRows.map((r) => ({
          predictionId: r.id,
          peerAddress: r.peerAddress,
          amountAtomic: plan.shareAtomic,
        }));
        const results = await dispatchPayouts(
          sponsorWallet,
          pool.chainId,
          pool.stakeToken,
          payouts
        );
        for (const res of results) {
          if (res.txHash) {
            await prismaQuery.prediction.update({
              where: { id: res.predictionId },
              data: {
                status: 'won',
                payoutTxHash: res.txHash,
                payoutAmountAtomic: res.amountAtomic.toString(),
              },
            });
            try {
              eventBus.publish('prediction.payout', {
                poolId: pool.id,
                predictionId: res.predictionId,
                txHash: res.txHash,
                toAddress: shortenAddress(res.peerAddress),
                amount: res.amountAtomic.toString(),
                amountFormatted: formatUsdt(res.amountAtomic.toString()),
                roomSlug: pool.roomSlug,
                matchId: pool.matchId,
              });
            } catch (err) {
              console.warn(
                '[PredictionSettlement] eventBus publish failed:',
                (err as Error)?.message
              );
            }
          }
        }
        await prismaQuery.predictionPool.update({
          where: { id: pool.id },
          data: { status: 'settled', settledAt: new Date() },
        });
        try {
          eventBus.publish('prediction.settled', {
            poolId: pool.id,
            roomSlug: pool.roomSlug,
            matchId: pool.matchId,
            resultWinner: pool.resultWinner,
            resultHomeGoals: pool.resultHomeGoals,
            resultAwayGoals: pool.resultAwayGoals,
            winnersCount: winnerRows.length,
            usedExactScoreFallback: plan.usedExactScoreFallback,
          });
        } catch {
          /* best-effort */
        }
      } catch (err) {
        console.error(
          '[PredictionSettlement] settle failed for pool',
          pool.id,
          (err as Error)?.message
        );
      }
    }
  } catch (err) {
    console.error('[PredictionSettlement] tick error:', (err as Error)?.message);
  } finally {
    isRunning = false;
  }
};

export const startPredictionSettlementWorker = (): void => {
  if (!CURVA_PREDICTIONS_ENABLED) {
    console.log('[PredictionSettlement] disabled (CURVA_PREDICTIONS_ENABLED != true)');
    return;
  }
  console.log(`[PredictionSettlement] Scheduled: ${PREDICTIONS_SETTLEMENT_CRON}`);
  cron.schedule(PREDICTIONS_SETTLEMENT_CRON, () => {
    void settleTick();
  });
};

// Test-only entrypoint so the unit tests can drive one tick deterministically
// without waiting for the cron schedule.
export const __runOnceForTest = settleTick;
