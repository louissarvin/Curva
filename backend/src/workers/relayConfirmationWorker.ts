/**
 * F11 EIP-3009 facilitator confirmation worker.
 *
 * Every RELAY_CONFIRMATION_CRON tick (default every 15s):
 *   1. Refresh sponsor balances for every enabled chain (so /wdk/relay/health
 *      never live-fetches on a public GET).
 *   2. Find FacilitatorTx rows in 'submitted' status older than 10s (to avoid
 *      racing the pending mempool).
 *   3. For each, fetch the receipt on the tx's chain. If receipt.status===1
 *      mark confirmed + publish 'facilitator.confirmed'; if ===0 mark failed +
 *      publish 'facilitator.failed'.
 *   4. Rows in 'submitted' longer than RELAY_CONFIRMATION_TIMEOUT_MIN get
 *      marked 'failed' with errorMessage 'confirmation timeout'.
 *
 * Guarded by an `isRunning` flag per the backend conventions memory: overlapping
 * ticks skip loudly rather than compound RPC load.
 *
 * Per-chain isolation: a failing chain does not block the loop; the next chain
 * still runs. All errors are logged, none crash the worker.
 */

import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { withProviderForChain } from '../lib/evm/provider.ts';
import { getChain, getEnabledChains } from '../lib/evm/chains.ts';
import {
  isFacilitatorEnabled,
  refreshAllSponsorBalances,
} from '../lib/evm/facilitator.ts';
import { eventBus } from '../lib/activity/eventBus.ts';
import { shortenAddress } from '../utils/miscUtils.ts';
import { formatUsdt } from '../lib/evm/usdtIndexer.ts';
import {
  RELAY_CONFIRMATION_CRON,
  RELAY_CONFIRMATION_TIMEOUT_MIN,
} from '../config/main-config.ts';

let isRunning = false;

const RECENT_SUBMIT_BUFFER_MS = 10_000; // ignore rows submitted <10s ago
const MAX_ROWS_PER_TICK = 100; // hard bound; free-tier RPCs cap around 10 req/s

interface PendingRow {
  id: string;
  chainId: number;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  submittedAt: Date;
}

const publishConfirmed = async (row: PendingRow, blockNumber: number, confirmedAtIso: string) => {
  const chain = getChain(row.chainId);
  try {
    const room = await prismaQuery.room.findFirst({
      where: { hostSmartAddress: row.toAddress.toLowerCase(), deletedAt: null },
      select: { slug: true, matchId: true },
    });
    const explorerUrl =
      chain?.explorerBase && chain.explorerBase.length > 0
        ? `${chain.explorerBase.replace(/\/$/, '')}/tx/${row.txHash}`
        : null;
    eventBus.publish('facilitator.confirmed', {
      txHash: shortenAddress(row.txHash, 10, 6),
      txHashFull: row.txHash,
      explorerUrl,
      chainId: row.chainId,
      chainName: chain?.name ?? String(row.chainId),
      fromAddress: shortenAddress(row.fromAddress),
      toAddress: shortenAddress(row.toAddress),
      amount: row.amount,
      amountFormatted: formatUsdt(row.amount),
      roomSlug: room?.slug ?? null,
      matchId: room?.matchId ?? null,
      confirmedBlock: blockNumber,
      confirmedAt: confirmedAtIso,
    });
  } catch (err) {
    console.warn(
      '[relayConfirmationWorker] eventBus publish (confirmed) failed:',
      (err as Error)?.message
    );
  }
};

const publishFailed = (row: PendingRow, errorMessage: string) => {
  const chain = getChain(row.chainId);
  try {
    eventBus.publish('facilitator.failed', {
      txHash: shortenAddress(row.txHash, 10, 6),
      chainId: row.chainId,
      chainName: chain?.name ?? String(row.chainId),
      fromAddress: shortenAddress(row.fromAddress),
      errorMessage,
    });
  } catch (err) {
    console.warn(
      '[relayConfirmationWorker] eventBus publish (failed) failed:',
      (err as Error)?.message
    );
  }
};

const processRow = async (row: PendingRow): Promise<void> => {
  const chain = getChain(row.chainId);
  if (!chain || !chain.enabled) {
    // Chain was disabled after submit. Mark failed and move on.
    await prismaQuery.facilitatorTx.update({
      where: { id: row.id },
      data: { status: 'failed', errorMessage: 'chain disabled after submit' },
    });
    publishFailed(row, 'chain disabled after submit');
    return;
  }

  // Fetch receipt through the pool with automatic failover.
  let receipt: { status: number | null; blockNumber: number } | null = null;
  try {
    receipt = await withProviderForChain(chain, async (provider) => {
      const r = await provider.getTransactionReceipt(row.txHash);
      if (r === null) return null;
      return { status: r.status ?? null, blockNumber: r.blockNumber };
    });
  } catch (err) {
    console.warn(
      `[relayConfirmationWorker] getTransactionReceipt failed for ${row.txHash} on chain=${row.chainId}:`,
      (err as Error)?.message
    );
    // Leave as 'submitted'; the timeout branch below will eventually mark failed.
    receipt = null;
  }

  if (receipt !== null) {
    if (receipt.status === 1) {
      const confirmedAt = new Date();
      await prismaQuery.facilitatorTx.update({
        where: { id: row.id },
        data: {
          status: 'confirmed',
          confirmedAt,
          confirmedBlock: receipt.blockNumber,
        },
      });
      await publishConfirmed(row, receipt.blockNumber, confirmedAt.toISOString());
      return;
    }
    if (receipt.status === 0) {
      await prismaQuery.facilitatorTx.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          errorMessage: 'transaction reverted',
          confirmedBlock: receipt.blockNumber,
        },
      });
      publishFailed(row, 'transaction reverted');
      return;
    }
    // Unknown status; leave for next tick.
    return;
  }

  // No receipt yet. If we're past the timeout window, mark failed.
  const ageMs = Date.now() - row.submittedAt.getTime();
  if (ageMs > RELAY_CONFIRMATION_TIMEOUT_MIN * 60_000) {
    await prismaQuery.facilitatorTx.update({
      where: { id: row.id },
      data: { status: 'failed', errorMessage: 'confirmation timeout' },
    });
    publishFailed(row, 'confirmation timeout');
  }
};

const tick = async (): Promise<void> => {
  if (isRunning) {
    console.log('[relayConfirmationWorker] Previous run still active, skipping...');
    return;
  }
  if (!isFacilitatorEnabled()) return;
  isRunning = true;
  try {
    // Refresh sponsor balances for enabled chains so /wdk/relay/health has
    // fresh numbers without live-fetching on the public GET.
    try {
      await refreshAllSponsorBalances();
    } catch (err) {
      console.warn(
        '[relayConfirmationWorker] balance refresh failed:',
        (err as Error)?.message
      );
    }

    const enabledChainIds = new Set(getEnabledChains().map((c) => c.chainId));
    if (enabledChainIds.size === 0) return;

    const bufferCutoff = new Date(Date.now() - RECENT_SUBMIT_BUFFER_MS);
    const rows = (await prismaQuery.facilitatorTx.findMany({
      where: {
        status: 'submitted',
        submittedAt: { lt: bufferCutoff },
      },
      orderBy: { submittedAt: 'asc' },
      take: MAX_ROWS_PER_TICK,
      select: {
        id: true,
        chainId: true,
        txHash: true,
        fromAddress: true,
        toAddress: true,
        amount: true,
        submittedAt: true,
      },
    })) as PendingRow[];

    for (const row of rows) {
      if (!enabledChainIds.has(row.chainId)) continue;
      try {
        await processRow(row);
      } catch (err) {
        // Never propagate — worker must survive a single row's problem.
        console.error(
          `[relayConfirmationWorker] processRow failed for ${row.txHash}:`,
          (err as Error)?.message
        );
      }
    }
  } catch (err) {
    console.error(
      '[relayConfirmationWorker] Tick error:',
      (err as Error)?.message ?? String(err)
    );
  } finally {
    isRunning = false;
  }
};

export const startRelayConfirmationWorker = (): void => {
  if (!isFacilitatorEnabled()) {
    console.log(
      '[relayConfirmationWorker] Facilitator disabled — worker not scheduled.'
    );
    return;
  }
  console.log(`[relayConfirmationWorker] Scheduled: ${RELAY_CONFIRMATION_CRON}`);
  cron.schedule(RELAY_CONFIRMATION_CRON, tick);
};

/**
 * Test-only: expose the tick and reset the guard.
 */
export const __tickForTest = tick;
export const __resetForTest = (): void => {
  isRunning = false;
};
