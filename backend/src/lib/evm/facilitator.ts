/**
 * F11 EIP-3009 facilitator — sponsor wallet lifecycle + submit path.
 *
 * Per ADR-010: the sponsor is a burnable demo wallet that pays gas for peer-
 * signed authorizations. RELAY_SPONSOR_PK is read once at module init and
 * dropped from the local scope after the ethers.Wallet is constructed. The
 * Wallet object retains the PK in its own memory; we cannot forcibly strip it
 * in Node/Bun. The PK is never logged.
 *
 * When `RELAY_SPONSOR_PK` is unset OR `RELAY_SPONSOR_ENABLED=false`, this module
 * exports `isFacilitatorEnabled() === false` and every submit throws
 * FacilitatorDisabledError. The route layer wraps that as a 404 (hide-existence
 * per ADR-007). No RPC calls happen when disabled.
 */

import { ethers } from 'ethers';
import type { JsonRpcProvider } from 'ethers';
import { getChain, getEnabledChains, type ChainConfig } from './chains.ts';
import { withProviderForChain } from './provider.ts';
import { EIP3009_TOKEN_ABI, type Eip3009Message, type Eip3009Signature } from './eip3009.ts';
import {
  RELAY_ALLOWED_TOKENS,
  RELAY_MAX_AMOUNT_USDT_WEI,
  RELAY_MIN_SPONSOR_BALANCE_WEI,
  RELAY_ONLY_REGISTERED_HOSTS,
  RELAY_SPONSOR_ENABLED,
  RELAY_SPONSOR_PK,
} from '../../config/main-config.ts';

// =============================================================================
// Sponsor wallet — instantiated once at module load, PK dropped after.
// =============================================================================

const FACILITATOR_ENABLED = Boolean(RELAY_SPONSOR_PK) && RELAY_SPONSOR_ENABLED === true;

// Never re-derived from an env var at request time. Also intentionally
// NOT re-exported as a raw string of the PK.
let SPONSOR_WALLET: ethers.Wallet | null = null;
let SPONSOR_ADDRESS: string | null = null;

if (FACILITATOR_ENABLED) {
  try {
    // ethers.Wallet accepts a raw 0x-prefixed 32-byte hex private key. If the
    // env value is malformed the constructor throws; we catch to keep the
    // process boot-safe and mark the facilitator disabled with a warning.
    const pk = RELAY_SPONSOR_PK as string;
    SPONSOR_WALLET = new ethers.Wallet(pk);
    SPONSOR_ADDRESS = SPONSOR_WALLET.address.toLowerCase();
    // Best-effort local variable drop. The wallet still holds the PK internally
    // (unavoidable in Node/Bun) but our scope no longer has a bare reference.
    // The env var itself remains accessible via process.env; that is outside
    // the facilitator's concern (ops responsibility to protect the runtime env).
    console.log(`[facilitator] enabled with sponsor ${SPONSOR_ADDRESS.slice(0, 6)}...${SPONSOR_ADDRESS.slice(-4)}`);
  } catch (err) {
    console.error(
      `[facilitator] FATAL failed to instantiate sponsor wallet: ${
        (err as Error)?.message ?? String(err)
      }. Endpoints will return 404.`
    );
    SPONSOR_WALLET = null;
    SPONSOR_ADDRESS = null;
  }
} else {
  console.log('[facilitator] disabled (RELAY_SPONSOR_PK unset or RELAY_SPONSOR_ENABLED=false)');
}

// =============================================================================
// Public state helpers
// =============================================================================

export const isFacilitatorEnabled = (): boolean =>
  SPONSOR_WALLET !== null && SPONSOR_ADDRESS !== null;

export const getSponsorAddress = (): string | null => SPONSOR_ADDRESS;

export const isTokenAllowed = (tokenAddress: string): boolean =>
  RELAY_ALLOWED_TOKENS.includes(tokenAddress.toLowerCase());

export const getMaxAmountBaseUnits = (): bigint => RELAY_MAX_AMOUNT_USDT_WEI;

export const getMinSponsorBalanceWei = (): bigint => RELAY_MIN_SPONSOR_BALANCE_WEI;

export const isOnlyRegisteredHosts = (): boolean => RELAY_ONLY_REGISTERED_HOSTS;

// =============================================================================
// Sponsor balance cache. Populated by the confirmation worker every ~60s and
// read by /wdk/relay/health. /wdk/relay/eip3009 also refreshes the entry for
// the target chain right before submit so the balance floor gate is fresh.
// =============================================================================

interface BalanceCacheEntry {
  chainId: number;
  chainName: string;
  balanceWei: bigint;
  lastCheckedAt: number; // ms epoch
  lastSubmitAt: number | null;
}

const BALANCE_CACHE = new Map<number, BalanceCacheEntry>();

export const getCachedSponsorBalance = (chainId: number): BalanceCacheEntry | null => {
  return BALANCE_CACHE.get(chainId) ?? null;
};

export const listCachedSponsorBalances = (): BalanceCacheEntry[] => {
  return Array.from(BALANCE_CACHE.values());
};

export const noteSponsorSubmit = (chainId: number, ts: number): void => {
  const entry = BALANCE_CACHE.get(chainId);
  if (entry) entry.lastSubmitAt = ts;
};

/**
 * Fetch and cache the sponsor's balance on the given chain. Returns null when
 * the facilitator is disabled OR the chain is not configured. Cached even on
 * failure with balanceWei=0 so /wdk/relay/health can still render an entry.
 */
export const refreshSponsorBalance = async (
  chainId: number
): Promise<BalanceCacheEntry | null> => {
  if (!isFacilitatorEnabled() || SPONSOR_ADDRESS === null) return null;
  const chain = getChain(chainId);
  if (!chain || !chain.enabled) return null;

  try {
    const balanceWei = await withProviderForChain(chain, async (provider) =>
      provider.getBalance(SPONSOR_ADDRESS as string)
    );
    const entry: BalanceCacheEntry = {
      chainId,
      chainName: chain.name,
      balanceWei,
      lastCheckedAt: Date.now(),
      lastSubmitAt: BALANCE_CACHE.get(chainId)?.lastSubmitAt ?? null,
    };
    BALANCE_CACHE.set(chainId, entry);
    return entry;
  } catch (err) {
    console.warn(
      `[facilitator] balance probe failed on chain=${chainId}: ${
        (err as Error)?.message ?? String(err)
      }`
    );
    // Do not overwrite a previous successful reading with 0; only seed an empty
    // entry if we have nothing yet.
    if (!BALANCE_CACHE.has(chainId)) {
      BALANCE_CACHE.set(chainId, {
        chainId,
        chainName: chain.name,
        balanceWei: 0n,
        lastCheckedAt: Date.now(),
        lastSubmitAt: null,
      });
    }
    return BALANCE_CACHE.get(chainId) ?? null;
  }
};

/**
 * Refresh balances for every enabled chain. Called from the confirmation
 * worker so /wdk/relay/health never live-fetches on a public GET.
 */
export const refreshAllSponsorBalances = async (): Promise<void> => {
  if (!isFacilitatorEnabled()) return;
  for (const chain of getEnabledChains()) {
    await refreshSponsorBalance(chain.chainId);
  }
};

// =============================================================================
// Submit path
// =============================================================================

export class FacilitatorDisabledError extends Error {
  constructor() {
    super('Facilitator disabled');
    this.name = 'FacilitatorDisabledError';
  }
}

export class FacilitatorSponsorLowError extends Error {
  constructor(public readonly balanceWei: bigint, public readonly floorWei: bigint) {
    super('Sponsor balance below floor');
    this.name = 'FacilitatorSponsorLowError';
  }
}

export class FacilitatorRpcError extends Error {
  constructor(public readonly cause: Error) {
    super('RPC submit failed');
    this.name = 'FacilitatorRpcError';
  }
}

export class FacilitatorNonceUsedError extends Error {
  constructor() {
    super('Authorization nonce already used on-chain');
    this.name = 'FacilitatorNonceUsedError';
  }
}

export interface SubmitRelayOpts {
  chainId: number;
  tokenAddress: string; // lowercase
  message: Eip3009Message;
  signature: Eip3009Signature;
}

export interface SubmitRelayResult {
  txHash: string;
  sponsorAddress: string;
}

/**
 * Submit a signed EIP-3009 authorization to the chain via the sponsor wallet.
 * Callers must have already validated the signature; this function does NOT
 * re-verify — it only relays.
 *
 * Errors:
 * - FacilitatorDisabledError when the sponsor is not configured.
 * - FacilitatorSponsorLowError when the sponsor balance is below the floor.
 * - FacilitatorNonceUsedError when the token contract rejects the nonce.
 * - FacilitatorRpcError for any other RPC-side failure.
 */
export const submitEip3009Relay = async (
  opts: SubmitRelayOpts
): Promise<SubmitRelayResult> => {
  if (!isFacilitatorEnabled() || SPONSOR_WALLET === null || SPONSOR_ADDRESS === null) {
    throw new FacilitatorDisabledError();
  }
  const chain = getChain(opts.chainId);
  if (!chain || !chain.enabled) {
    throw new FacilitatorRpcError(new Error(`chain ${opts.chainId} not enabled`));
  }

  // Balance floor gate — refresh cache first so we never relay on a stale value.
  const balance = await refreshSponsorBalance(opts.chainId);
  if (balance && balance.balanceWei < RELAY_MIN_SPONSOR_BALANCE_WEI) {
    throw new FacilitatorSponsorLowError(balance.balanceWei, RELAY_MIN_SPONSOR_BALANCE_WEI);
  }

  // Bind the sponsor wallet to a provider from the pool and submit.
  return withProviderForChain(chain, async (provider: JsonRpcProvider) => {
    // ethers v6: Wallet.connect returns a new Wallet with the same PK bound to
    // the given provider. Safe to construct per-request; the underlying PK
    // reference is unchanged.
    const signer = (SPONSOR_WALLET as ethers.Wallet).connect(provider);
    const contract = new ethers.Contract(opts.tokenAddress, EIP3009_TOKEN_ABI, signer);
    try {
      const tx = await contract.transferWithAuthorization(
        opts.message.from,
        opts.message.to,
        opts.message.value,
        opts.message.validAfter,
        opts.message.validBefore,
        opts.message.nonce,
        opts.signature.v,
        opts.signature.r,
        opts.signature.s
      );
      // Do NOT await tx.wait(); confirmation is the worker's job.
      const txHash = String(tx.hash).toLowerCase();
      noteSponsorSubmit(opts.chainId, Date.now());
      return { txHash, sponsorAddress: SPONSOR_ADDRESS as string };
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      // Classify EIP-3009 "authorization already used" from other on-chain
      // rejections. Token contracts vary; look for the canonical revert string.
      if (
        /authorization is used/i.test(msg) ||
        /authorization used/i.test(msg) ||
        /nonce (?:already )?used/i.test(msg)
      ) {
        throw new FacilitatorNonceUsedError();
      }
      throw new FacilitatorRpcError(err as Error);
    }
  });
};

// =============================================================================
// Health snapshot
// =============================================================================

export interface FacilitatorHealth {
  enabled: boolean;
  sponsorAddress: string | null;
  balances: Array<{
    chainId: number;
    chainName: string;
    balanceWei: string;
    balanceEth: string; // 4dp
    healthy: boolean;
    lastSubmitAt: string | null;
  }>;
  allowedTokens: string[];
  onlyRegisteredHosts: boolean;
  maxAmountUsdt: string;
}

const formatEth4dp = (wei: bigint): string => {
  // 1 ETH = 10^18 wei. Show 4dp.
  const abs = wei < 0n ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = ((abs % 10n ** 18n) * 10000n) / 10n ** 18n;
  const fracStr = frac.toString().padStart(4, '0');
  return `${wei < 0n ? '-' : ''}${whole.toString()}.${fracStr}`;
};

export const getFacilitatorHealth = (): FacilitatorHealth => {
  const entries = listCachedSponsorBalances();
  return {
    enabled: isFacilitatorEnabled(),
    sponsorAddress: SPONSOR_ADDRESS,
    balances: entries.map((e) => ({
      chainId: e.chainId,
      chainName: e.chainName,
      balanceWei: e.balanceWei.toString(),
      balanceEth: formatEth4dp(e.balanceWei),
      healthy: e.balanceWei >= RELAY_MIN_SPONSOR_BALANCE_WEI,
      lastSubmitAt: e.lastSubmitAt === null ? null : new Date(e.lastSubmitAt).toISOString(),
    })),
    allowedTokens: [...RELAY_ALLOWED_TOKENS],
    onlyRegisteredHosts: RELAY_ONLY_REGISTERED_HOSTS,
    maxAmountUsdt: (RELAY_MAX_AMOUNT_USDT_WEI / 1_000_000n).toString(),
  };
};

// =============================================================================
// Test hooks
// =============================================================================

/**
 * Test-only: swap the sponsor wallet with a stub. NEVER call from production.
 * The route tests inject a random-key wallet so the submit path can be exercised
 * without RELAY_SPONSOR_PK being set in test env.
 */
export const __setSponsorForTest = (wallet: ethers.Wallet | null): void => {
  SPONSOR_WALLET = wallet;
  SPONSOR_ADDRESS = wallet ? wallet.address.toLowerCase() : null;
};

export const __resetBalanceCacheForTest = (): void => {
  BALANCE_CACHE.clear();
};

/**
 * Wave 10: expose the sponsor wallet to the prediction settlement worker so it
 * can send batch payouts through the SAME sponsor that receives the pool
 * entries. Returns null when the facilitator is disabled. Consumers must NOT
 * cache the returned reference across restarts — the wallet is re-instantiated
 * at module load, not per call.
 *
 * This is intentionally exported as `__getSponsorWallet` (double-underscore)
 * to signal that it's a privileged getter and not part of the public HTTP
 * surface. The predictionSettlementWorker calls it once per tick.
 */
export const __getSponsorWallet = (): ethers.Wallet | null => SPONSOR_WALLET;

// Re-export chain type for callers that want it.
export type { ChainConfig };
