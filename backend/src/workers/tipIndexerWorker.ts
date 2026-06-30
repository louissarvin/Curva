import cron from 'node-cron';
import { runIndexerScan } from '../lib/evm/usdtIndexer.ts';
import { getEnabledChains } from '../lib/evm/chains.ts';
import { TIP_INDEXER_INTERVAL_CRON } from '../config/main-config.ts';

// One outer guard so two ticks never overlap globally — keeps RPC concurrency
// predictable on free-tier nodes. Inside a tick, chains run sequentially so a
// slow chain just delays the next chain's scan; this is intentional per
// ARCHITECTURE.md Section 20 F10 ("Per-chain scans run sequentially within a
// tick to keep RPC concurrency predictable").
let tickRunning = false;

// Per-chain failure counters keyed by chainId. We log a louder warning once a
// chain crosses 5 consecutive failures so on-call sees the chain has stalled.
const consecutiveFailures = new Map<number, number>();
const LOUD_WARN_THRESHOLD = 5;
const loudWarnedFor = new Set<number>();

const tick = async (): Promise<void> => {
  if (tickRunning) {
    console.log('[tipIndexerWorker] Previous run still active, skipping...');
    return;
  }
  tickRunning = true;
  try {
    const chains = getEnabledChains();
    if (chains.length === 0) {
      // Edge case: no chains enabled (everyone disabled in config). Log once
      // per tick — quiet enough not to spam, loud enough to notice.
      console.warn('[TipIndexer] No chains enabled; nothing to do.');
      return;
    }
    for (const chain of chains) {
      try {
        const result = await runIndexerScan(chain);
        consecutiveFailures.set(chain.chainId, 0);
        loudWarnedFor.delete(chain.chainId);
        if (result && (result.eventCount > 0 || result.insertedCount > 0)) {
          console.log(
            `[TipIndexer][chain=${chain.chainId}][${chain.name}] scanned ${result.scannedFrom}->${result.scannedTo}, hosts=${result.hostCount}, events=${result.eventCount}, inserted=${result.insertedCount}`
          );
        }
      } catch (err) {
        const next = (consecutiveFailures.get(chain.chainId) ?? 0) + 1;
        consecutiveFailures.set(chain.chainId, next);
        console.error(
          `[TipIndexer][chain=${chain.chainId}][${chain.name}] scan failed (${next}x in a row):`,
          (err as Error)?.message || err
        );
        if (next >= LOUD_WARN_THRESHOLD && !loudWarnedFor.has(chain.chainId)) {
          console.error(
            `[TipIndexer] chain ${chain.chainId} (${chain.name}) has failed ${next} ticks in a row — check RPC reachability or contract address`
          );
          loudWarnedFor.add(chain.chainId);
        }
        // continue to next chain
      }
    }
  } finally {
    tickRunning = false;
  }
};

export const startTipIndexerWorker = (): void => {
  const enabled = getEnabledChains();
  console.log(
    `[TipIndexer] Worker scheduled: ${TIP_INDEXER_INTERVAL_CRON}. Enabled chains: ${
      enabled.length === 0
        ? '(none)'
        : enabled.map((c) => `${c.chainId}/${c.name}`).join(', ')
    }`
  );
  cron.schedule(TIP_INDEXER_INTERVAL_CRON, tick);
  // Don't run immediately on boot — let the rest of the system finish initializing first.
  setTimeout(() => void tick(), 5000);
};

/**
 * Test-only: reset internal state so a test can re-run the worker cleanly.
 */
export const __resetForTest = (): void => {
  tickRunning = false;
  consecutiveFailures.clear();
  loudWarnedFor.clear();
};
