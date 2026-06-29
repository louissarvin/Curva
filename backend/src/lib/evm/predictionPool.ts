/**
 * Wave 10 — Match Prediction Pool settlement library.
 *
 * Pure functions for computing winners + payout shares from a set of
 * confirmed predictions, plus a helper that dispatches ERC-20 batch payouts
 * via the existing sponsor wallet.
 *
 * Docs-first references (verified 2026-07-04):
 *  - EIP-3009 validAfter/validBefore semantics are EXCLUSIVE on both sides
 *    (see eips.ethereum.org/EIPS/eip-3009). We validate this at ingress
 *    before touching the DB.
 *  - Candide docs confirm the sponsor-wallet model where a burnable EOA
 *    pays gas for on-behalf-of transfers
 *    (docs.candide.dev/wallet/paymaster/erc20-paymasters). Wave 10 uses the
 *    ERC-20 route ('erc20-transfer'), not a UserOp bundle, because the F11
 *    facilitator's sponsor wallet already holds the pool USDT balance and
 *    can send transfer() calls directly.
 *
 * Hackathon simplification (documented so audit teams do not miss it):
 *   The "pool address" is a sponsor-controlled EOA sub-address (currently
 *   just the F11 sponsor address). Production would use a real escrow
 *   contract with slashing, time-locked withdrawals, and multi-sig. That
 *   deliberate trade-off is what let us ship real on-chain settlement in
 *   time for the demo.
 *
 * Failure modes considered:
 *   - No winners: pool is REFUNDED to every confirmed entry. Not settled.
 *   - Exact-score fallback: if the pool is exact-score AND nobody hit the
 *     exact score, winners fall back to peers who at least got the winner
 *     side right ('HOME' | 'AWAY' | 'DRAW'). Documented behaviour so hosts
 *     know what happens; peers see this in the panel.
 *   - Rounding: pool total / winner count is integer division on base
 *     units. Remainder stays in the sponsor wallet (< $0.000001 per USDT
 *     entry — non-material at demo scale).
 */

import { ethers } from 'ethers';
import type { JsonRpcProvider } from 'ethers';
import { withProviderForChain } from './provider.ts';
import { getChain } from './chains.ts';
import { EIP3009_TOKEN_ABI } from './eip3009.ts';

// =============================================================================
// Types
// =============================================================================

export type PoolMode = 'winner-only' | 'exact-score';
export type PoolStatus = 'open' | 'locked' | 'settled' | 'refunded';
export type PredictionStatus = 'pending' | 'confirmed' | 'refunded' | 'won';
export type WinnerSide = 'HOME' | 'AWAY' | 'DRAW';

export interface PredictionRow {
  id: string;
  peerAddress: string;
  winner: WinnerSide;
  homeGoals: number | null;
  awayGoals: number | null;
  stakeAtomic: string;
  status: PredictionStatus;
}

export interface MatchResult {
  winner: WinnerSide;
  homeGoals: number;
  awayGoals: number;
}

export interface SettlementPlan {
  totalPoolAtomic: bigint;
  winnerIds: string[];
  shareAtomic: bigint;
  remainderAtomic: bigint;
  usedExactScoreFallback: boolean;
  refundRequired: boolean;
}

// =============================================================================
// Validators
// =============================================================================

export const isValidPoolMode = (s: unknown): s is PoolMode =>
  s === 'winner-only' || s === 'exact-score';

export const isValidWinnerSide = (s: unknown): s is WinnerSide =>
  s === 'HOME' || s === 'AWAY' || s === 'DRAW';

export const isValidGoals = (n: unknown): boolean =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 30;

/**
 * Derive the winner side from a home/away goals pair. Pure, so both the host
 * ingress validator AND the settlement worker use the same definition.
 */
export const deriveWinnerSide = (homeGoals: number, awayGoals: number): WinnerSide => {
  if (homeGoals > awayGoals) return 'HOME';
  if (awayGoals > homeGoals) return 'AWAY';
  return 'DRAW';
};

// =============================================================================
// Settlement math — PURE. No DB, no RPC. Fully unit-testable.
// =============================================================================

/**
 * Compute the settlement plan for a confirmed prediction set.
 *
 * Rules (documented in the schema.prisma header):
 *   winner-only: winners are predictions whose `winner` matches result.winner.
 *   exact-score: winners are predictions whose (homeGoals, awayGoals) match
 *                result exactly. If none, FALL BACK to winner-only among
 *                predictions that at least got the side right.
 *
 * When there are zero winners even after fallback the plan sets
 * refundRequired=true and callers must dispatch refunds instead of payouts.
 *
 * Integer arithmetic throughout. bigint is required because 100 USDT * 32
 * peers overflows JS Number in atomic units.
 */
export const computeSettlement = (
  mode: PoolMode,
  predictions: PredictionRow[],
  result: MatchResult
): SettlementPlan => {
  // Only confirmed entries participate. Pending/refunded/won are filtered.
  const confirmed = predictions.filter((p) => p.status === 'confirmed');

  // Total pool = sum of all confirmed stakes. bigint to avoid precision loss.
  let totalPoolAtomic = 0n;
  for (const p of confirmed) {
    try {
      totalPoolAtomic += BigInt(p.stakeAtomic);
    } catch {
      // Skip a malformed row rather than throwing — the settlement worker
      // logs it separately. We must never crash the settle path on one row.
      continue;
    }
  }

  let winners: PredictionRow[] = [];
  let usedExactScoreFallback = false;

  if (mode === 'exact-score') {
    winners = confirmed.filter(
      (p) => p.homeGoals === result.homeGoals && p.awayGoals === result.awayGoals
    );
    if (winners.length === 0) {
      // Fallback: any peer who at least got the winner side right.
      winners = confirmed.filter((p) => p.winner === result.winner);
      usedExactScoreFallback = true;
    }
  } else {
    winners = confirmed.filter((p) => p.winner === result.winner);
  }

  if (winners.length === 0 || totalPoolAtomic === 0n) {
    return {
      totalPoolAtomic,
      winnerIds: [],
      shareAtomic: 0n,
      remainderAtomic: totalPoolAtomic,
      usedExactScoreFallback,
      refundRequired: winners.length === 0 && confirmed.length > 0,
    };
  }

  const winnerCount = BigInt(winners.length);
  const shareAtomic = totalPoolAtomic / winnerCount;
  const remainderAtomic = totalPoolAtomic - shareAtomic * winnerCount;

  return {
    totalPoolAtomic,
    winnerIds: winners.map((w) => w.id),
    shareAtomic,
    remainderAtomic,
    usedExactScoreFallback,
    refundRequired: false,
  };
};

// =============================================================================
// Payout dispatch — sponsor wallet sends real ERC-20 transfer() per winner.
// =============================================================================

export class PredictionPayoutError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'PredictionPayoutError';
  }
}

export interface PayoutRecipient {
  predictionId: string;
  peerAddress: string;
  amountAtomic: bigint;
}

export interface PayoutResult {
  predictionId: string;
  txHash: string;
  peerAddress: string;
  amountAtomic: bigint;
}

/**
 * Send a batch of ERC-20 transfers from the sponsor wallet to every winner.
 * One transaction per winner (batch-in-flight, not batched-onchain) so we
 * can attribute each payout to a specific Prediction row.
 *
 * A UserOp bundle would batch all transfers on-chain, but the F11 sponsor
 * is a plain EOA + 4337 is out of scope for Wave 10. Per-recipient tx is
 * fine at hackathon scale (< 32 winners per pool).
 *
 * Errors:
 *   PredictionPayoutError when the sponsor wallet is not available OR the
 *   chain is not configured. Individual per-recipient failures are captured
 *   in the returned results array (txHash === '' means that recipient
 *   failed; the settlement worker retries on the next tick).
 *
 * This function does NOT persist. The worker owns the DB update.
 */
export const dispatchPayouts = async (
  sponsorWallet: ethers.Wallet,
  chainId: number,
  tokenAddress: string,
  recipients: PayoutRecipient[]
): Promise<PayoutResult[]> => {
  const chain = getChain(chainId);
  if (!chain || !chain.enabled) {
    throw new PredictionPayoutError(`chain ${chainId} not enabled`);
  }
  if (recipients.length === 0) return [];

  return withProviderForChain(chain, async (provider: JsonRpcProvider) => {
    const signer = sponsorWallet.connect(provider);
    // ERC-20 transfer ABI is the ONLY function we call from the sponsor.
    // Kept separate from the EIP-3009 ABI so this module doesn't depend on
    // the wider tuple type.
    const TRANSFER_ABI = [
      'function transfer(address to, uint256 value) returns (bool)',
    ] as const;
    const contract = new ethers.Contract(tokenAddress, TRANSFER_ABI, signer);

    const out: PayoutResult[] = [];
    for (const r of recipients) {
      try {
        const tx = await contract.transfer(r.peerAddress, r.amountAtomic);
        out.push({
          predictionId: r.predictionId,
          peerAddress: r.peerAddress,
          amountAtomic: r.amountAtomic,
          txHash: String(tx.hash).toLowerCase(),
        });
      } catch (err) {
        // Log and continue — the worker retries pending winners next tick.
        console.warn(
          `[predictionPool] payout failed for ${r.peerAddress}: ${
            (err as Error)?.message ?? String(err)
          }`
        );
        out.push({
          predictionId: r.predictionId,
          peerAddress: r.peerAddress,
          amountAtomic: r.amountAtomic,
          txHash: '',
        });
      }
    }
    return out;
  });
};

/**
 * Derive the pool address for a given (roomSlug, matchId) tuple.
 *
 * Hackathon simplification: we route every pool to the F11 sponsor address
 * itself. This means all pool balances co-mingle inside the sponsor wallet
 * — the DB is the accounting ledger. Production would derive a unique
 * sub-address per pool using ERC-4337 sub-accounts OR deploy a per-pool
 * escrow contract.
 *
 * Passing a `sponsorAddress` explicitly (instead of importing from
 * facilitator.ts) keeps this module free of the facilitator's boot-time
 * side effects, which is important for the unit tests.
 */
export const derivePoolAddress = (
  sponsorAddress: string,
  _roomSlug: string,
  _matchId: string
): string => {
  return sponsorAddress.toLowerCase();
};
