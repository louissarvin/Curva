/**
 * Per-chain EVM provider cache + manual fallback wrapper.
 *
 * Each chain gets its own pool of ordered JsonRpcProviders. Within a chain, we
 * iterate providers in order on every call; the first that succeeds wins. We
 * also expose a per-chain health view consumed by /chains, /health, and /status.
 *
 * Why a manual fallback (not ethers' FallbackProvider): FallbackProvider quorums
 * across providers and adds latency + opacity that complicates debugging during
 * a hackathon. Ordered try-next-on-failure is easier to log and reason about.
 * The ChainConfig knob `rpcUrls` accepts N URLs and we wrap them in this
 * manual fallback per chain. Ethers v6's static Network constructor avoids the
 * chainId-detect roundtrip that would otherwise double cold-start latency
 * (docs.ethers.org/v6/api/providers/jsonrpc/#JsonRpcProvider).
 *
 * Lifecycle: providers are constructed lazily on first use per chainId and live
 * for the process lifetime. The worker calls `noteSuccess` / `noteFailure` to
 * update health; `/chains` reads from the same health map.
 */

import { ethers, JsonRpcProvider, Network } from 'ethers';
import { getChain, getDefaultChain, type ChainConfig } from './chains.ts';

interface ProviderEntry {
  url: string;
  provider: JsonRpcProvider;
  failuresInRow: number;
}

interface ChainHealth {
  /** Wall-clock ms of the last successful RPC call for this chain. */
  lastSuccessAt: number | null;
  /** Wall-clock ms of the last attempt for this chain (success or failure). */
  lastAttemptAt: number | null;
  /** Last block number observed by the indexer for this chain. */
  lastBlockNumber: number | null;
  /** Consecutive failures since the last success. Cleared on success. */
  consecutiveFailures: number;
}

const entriesByChain = new Map<number, ProviderEntry[]>();
const healthByChain = new Map<number, ChainHealth>();

// Unhealthy threshold: a chain is unhealthy if either (a) it has 5+ consecutive
// failures, or (b) more than HEALTH_LAG_MS has elapsed since the last success
// AND at least one attempt has been made.
const HEALTH_LAG_MS = 30_000;
const FAILURE_THRESHOLD = 5;

const buildEntries = (chain: ChainConfig): ProviderEntry[] => {
  if (chain.rpcUrls.length === 0) {
    throw new Error(
      `[EvmProvider] Chain ${chain.chainId} (${chain.name}) has no RPC URLs configured.`
    );
  }
  // Ethers v6: a static Network skips the chainId auto-discovery roundtrip on
  // every request. The Network constructor takes (name, chainId).
  const staticNetwork = new Network(chain.shortName || chain.name, chain.chainId);
  return chain.rpcUrls.map((url) => ({
    url,
    provider: new JsonRpcProvider(url, staticNetwork, { staticNetwork }),
    failuresInRow: 0,
  }));
};

const getEntries = (chain: ChainConfig): ProviderEntry[] => {
  const cached = entriesByChain.get(chain.chainId);
  if (cached) return cached;
  const fresh = buildEntries(chain);
  entriesByChain.set(chain.chainId, fresh);
  return fresh;
};

const getOrInitHealth = (chainId: number): ChainHealth => {
  let h = healthByChain.get(chainId);
  if (!h) {
    h = {
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastBlockNumber: null,
      consecutiveFailures: 0,
    };
    healthByChain.set(chainId, h);
  }
  return h;
};

/**
 * Public: get (or lazily build) the provider pool for a chainId. Throws if the
 * chain is unknown or has no RPC URLs.
 */
export const getProviderEntries = (chainId: number): ProviderEntry[] => {
  const chain = getChain(chainId);
  if (!chain) throw new Error(`[EvmProvider] Unknown chainId ${chainId}`);
  return getEntries(chain);
};

/**
 * Try each provider for `chain` in order. On failure, rotate to next. Updates
 * per-chain health on success/failure.
 */
export const withProviderForChain = async <T>(
  chain: ChainConfig,
  op: (provider: JsonRpcProvider) => Promise<T>
): Promise<T> => {
  const list = getEntries(chain);
  const health = getOrInitHealth(chain.chainId);
  health.lastAttemptAt = Date.now();
  let lastError: unknown = null;

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!entry) continue;
    try {
      const result = await op(entry.provider);
      entry.failuresInRow = 0;
      health.lastSuccessAt = Date.now();
      health.consecutiveFailures = 0;
      return result;
    } catch (err) {
      entry.failuresInRow += 1;
      lastError = err;
      console.warn(
        `[EvmProvider][chain=${chain.chainId}] RPC ${entry.url} failed (${entry.failuresInRow}x):`,
        (err as Error)?.message || err
      );
    }
  }

  health.consecutiveFailures += 1;
  throw new Error(
    `[EvmProvider][chain=${chain.chainId}] all ${list.length} RPC providers failed. Last error: ${
      (lastError as Error)?.message || String(lastError)
    }`
  );
};

/**
 * Record an observed block number for the chain so /chains can report it
 * without re-issuing an RPC call.
 */
export const noteLastBlock = (chainId: number, blockNumber: number): void => {
  const h = getOrInitHealth(chainId);
  h.lastBlockNumber = blockNumber;
};

export interface ChainProviderHealth {
  /** True only if a success has been recorded AND it's recent enough. */
  healthy: boolean;
  /** Last observed block number, or null if never observed. */
  lastBlockNumber: number | null;
  /** Wall-clock seconds since the last successful call, or null if none yet. */
  lagSeconds: number | null;
  /** Consecutive failure count since last success. */
  consecutiveFailures: number;
}

export const getProviderHealth = (chainId: number): ChainProviderHealth => {
  const h = healthByChain.get(chainId);
  if (!h) {
    return {
      healthy: false,
      lastBlockNumber: null,
      lagSeconds: null,
      consecutiveFailures: 0,
    };
  }
  const now = Date.now();
  const lagMs = h.lastSuccessAt === null ? null : now - h.lastSuccessAt;
  // Never-attempted chain: report unknown (healthy=false), but with a null lag
  // so the caller can render "Unknown" instead of "0s".
  if (h.lastAttemptAt === null) {
    return {
      healthy: false,
      lastBlockNumber: h.lastBlockNumber,
      lagSeconds: null,
      consecutiveFailures: h.consecutiveFailures,
    };
  }
  const healthy =
    h.consecutiveFailures < FAILURE_THRESHOLD &&
    h.lastSuccessAt !== null &&
    (lagMs ?? Infinity) < HEALTH_LAG_MS;
  return {
    healthy,
    lastBlockNumber: h.lastBlockNumber,
    lagSeconds: lagMs === null ? null : Math.floor(lagMs / 1000),
    consecutiveFailures: h.consecutiveFailures,
  };
};

// =============================================================================
// Legacy single-chain shims (kept for callers not yet migrated; remove after
// Wave 3 Step 5). The shims resolve to the default chain so old code keeps
// working through the transition.
// =============================================================================

/**
 * @deprecated Use `withProviderForChain(chain, op)` instead. Resolves to the
 * default chain (Sepolia) for backwards compatibility. Removed when Wave 3
 * Step 5 lands.
 */
export const withProvider = async <T>(
  op: (provider: JsonRpcProvider) => Promise<T>
): Promise<T> => {
  return withProviderForChain(getDefaultChain(), op);
};

/**
 * Convenience: bind a Contract to an explicit provider. Callers that need
 * automatic failover should pass the provider received from withProviderForChain.
 */
export const buildContract = (
  address: string,
  abi: ethers.InterfaceAbi,
  provider: JsonRpcProvider
) => new ethers.Contract(address, abi, provider);

/**
 * Test-only: clear cached entries + health so a test can re-inject URLs after
 * mutating chains.json env. Production code must not call this.
 */
export const __resetForTests = (): void => {
  entriesByChain.clear();
  healthByChain.clear();
};
