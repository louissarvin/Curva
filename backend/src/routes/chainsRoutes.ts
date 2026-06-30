/**
 * F10 multi-chain registry (ARCHITECTURE.md Section 20 + ADR-009).
 *
 *   GET /chains  — list every configured chain (enabled or not), with the
 *                  per-chain runtime health snapshot from the provider cache.
 *
 * Rate-limit: 30/min/IP via @fastify/rate-limit (same envelope as /phrasebook).
 * Cache: 10s in-memory; the indexer worker refreshes provider health on its
 * own tick so freshness is bounded by the worker cron (default 15s) anyway.
 *
 * Why expose Plasma even when disabled: the judging story is "we ship ready
 * for Plasma the day Tether flips the switch". `/chains` is the evidence
 * surface for that — judges curl it and see chainId 9746 listed alongside
 * Sepolia.
 *
 * Security:
 *  - RPC URLs are never echoed (they may carry API keys); we only echo the count.
 *  - usdtAddress is shortened to avoid being a free copy-paste of the contract
 *    (still public, but matches the rest of the API's redaction posture).
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { getAllConfiguredChains, getDefaultChain } from '../lib/evm/chains.ts';
import { getProviderHealth } from '../lib/evm/provider.ts';
import { TtlCache } from '../lib/cache.ts';
import { handleServerError } from '../utils/errorHandler.ts';
import { shortenAddress } from '../utils/miscUtils.ts';
import {
  CHAINS_CACHE_TTL_MS,
  CHAINS_RATE_LIMIT_MAX,
  CHAINS_RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';

interface ChainRow {
  chainId: number;
  name: string;
  shortName: string;
  isTestnet: boolean;
  isDefault: boolean;
  enabled: boolean;
  healthy: boolean | null;
  lastBlockNumber: number | null;
  lagSeconds: number | null;
  consecutiveFailures: number;
  usdtAddress: string;
  explorerBase: string;
  rpcCount: number;
  notes: string | null;
}

interface ChainsResponse {
  defaultChainId: number;
  chains: ChainRow[];
}

const responseCache = new TtlCache<ChainsResponse>(2);

const buildResponse = (): ChainsResponse => {
  const all = getAllConfiguredChains();
  const def = getDefaultChain();
  const rows: ChainRow[] = all.map((c) => {
    if (!c.enabled) {
      // Disabled chains have no provider entries; report "unknown" rather
      // than asserting health one way or the other. The clients can then
      // render a neutral badge.
      return {
        chainId: c.chainId,
        name: c.name,
        shortName: c.shortName,
        isTestnet: c.isTestnet,
        isDefault: c.isDefault,
        enabled: false,
        healthy: null,
        lastBlockNumber: null,
        lagSeconds: null,
        consecutiveFailures: 0,
        usdtAddress: c.usdtAddress ? shortenAddress(c.usdtAddress) : '',
        explorerBase: c.explorerBase,
        rpcCount: c.rpcUrls.length,
        notes: c.notes,
      };
    }
    const h = getProviderHealth(c.chainId);
    return {
      chainId: c.chainId,
      name: c.name,
      shortName: c.shortName,
      isTestnet: c.isTestnet,
      isDefault: c.isDefault,
      enabled: true,
      // healthy=null when we haven't tried yet (lagSeconds also null in that case).
      healthy: h.lagSeconds === null ? null : h.healthy,
      lastBlockNumber: h.lastBlockNumber,
      lagSeconds: h.lagSeconds,
      consecutiveFailures: h.consecutiveFailures,
      usdtAddress: c.usdtAddress ? shortenAddress(c.usdtAddress) : '',
      explorerBase: c.explorerBase,
      rpcCount: c.rpcUrls.length,
      notes: c.notes,
    };
  });
  return { defaultChainId: def.chainId, chains: rows };
};

const RATE_LIMIT_CFG = {
  rateLimit: {
    max: CHAINS_RATE_LIMIT_MAX,
    timeWindow: CHAINS_RATE_LIMIT_WINDOW,
  },
};

export const chainsRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/chains',
    { config: RATE_LIMIT_CFG },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = await responseCache.memoize('chains', CHAINS_CACHE_TTL_MS, async () =>
          buildResponse()
        );
        reply.header(
          'Cache-Control',
          `public, max-age=${Math.floor(CHAINS_CACHE_TTL_MS / 1000)}`
        );
        return reply.code(200).send({ success: true, error: null, data });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );
  done();
};

/**
 * Test-only: clear the in-memory cache between cases.
 */
export const __resetChainsCacheForTest = (): void => {
  responseCache.clear();
};
