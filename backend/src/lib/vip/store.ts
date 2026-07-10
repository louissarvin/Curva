/**
 * Semifinal Wave - VIP room slug reservation store.
 *
 * Docs-verification memo
 * ----------------------
 * Persistence model verified against:
 *   - PostgreSQL 16 unique constraint semantics
 *     https://www.postgresql.org/docs/current/ddl-constraints.html
 *     (P2002 fires on any @unique index collision, including composite ones)
 *   - Prisma 7 P2002 error code
 *     https://www.prisma.io/docs/orm/reference/error-reference#p2002
 *   - EIP-3009 (settled payments are unique per {chainId, nonce}), reused
 *     https://eips.ethereum.org/EIPS/eip-3009
 *   - x402 spec, retrieved 2026-07-10
 *     https://x402.org
 *   - WDK x402 docs
 *     https://docs.wdk.tether.io/ai/x402/
 *
 * Rationale for a real table (over an in-memory Map): every row here is the
 * receipt of a settled on-chain payment. Losing that on process restart is a
 * customer-facing failure — the peer already paid and would have to re-pay to
 * see their VIP slug reserved again. See ADR-010 for the sponsor-wallet risk
 * model that the payment path rides on.
 *
 * All slugs are normalized (lowercased, `vip-` prefix stripped) before hitting
 * the database. The API surface prefixes `vip-` back on when returning to the
 * client. This keeps the DB row shape clean and avoids ambiguity between the
 * "public" and "storage" forms of the same slug.
 */

import { prismaQuery } from '../prisma.ts';

// Slug validation, matched at ingress by the route. Kept here too so the
// store never trusts unvalidated input from a future direct caller.
export const VIP_SLUG_RE = /^[a-z0-9-]{3,32}$/;

export class SlugTakenError extends Error {
  constructor(public readonly slug: string) {
    super(`slug already reserved: ${slug}`);
    this.name = 'SlugTakenError';
  }
}

export class TxHashTakenError extends Error {
  constructor(public readonly txHash: string) {
    super(`tx already recorded: ${txHash}`);
    this.name = 'TxHashTakenError';
  }
}

export interface VipReservationRow {
  id: string;
  slug: string; // stored without the `vip-` prefix
  ownerAddress: string; // lowercase 0x...
  txHash: string; // lowercase 0x...
  reservedAt: Date;
}

const normalizeAddress = (addr: string): string => addr.toLowerCase();
const normalizeTxHash = (hash: string): string => hash.toLowerCase();

export const normalizeVipSlug = (raw: string): string => {
  const trimmed = String(raw || '').trim().toLowerCase();
  // Client may or may not include the `vip-` prefix; strip it if present.
  const stripped = trimmed.startsWith('vip-') ? trimmed.slice(4) : trimmed;
  return stripped;
};

export const isValidVipSlug = (normalized: string): boolean =>
  VIP_SLUG_RE.test(normalized);

/**
 * Look up a reservation by its normalized slug (no `vip-` prefix). Returns
 * null when the slug is available. This function never throws for a
 * not-found; only for infrastructure errors, which the caller wraps.
 */
export const getReservation = async (
  normalizedSlug: string
): Promise<VipReservationRow | null> => {
  const row = await prismaQuery.vipReservation.findUnique({
    where: { slug: normalizedSlug },
    select: {
      id: true,
      slug: true,
      ownerAddress: true,
      txHash: true,
      reservedAt: true,
    },
  });
  return row;
};

/**
 * Create a fresh reservation. Throws SlugTakenError on slug collision and
 * TxHashTakenError on tx-hash collision so the route layer can distinguish
 * 409-SLUG_ALREADY_RESERVED from an idempotent re-submit.
 */
export const createReservation = async (opts: {
  slug: string;
  ownerAddress: string;
  txHash: string;
}): Promise<VipReservationRow> => {
  const slug = normalizeVipSlug(opts.slug);
  if (!isValidVipSlug(slug)) {
    // The route validates first, but a defensive check keeps callers honest.
    throw new RangeError('invalid vip slug');
  }
  const ownerAddress = normalizeAddress(opts.ownerAddress);
  const txHash = normalizeTxHash(opts.txHash);
  try {
    const row = await prismaQuery.vipReservation.create({
      data: { slug, ownerAddress, txHash },
      select: {
        id: true,
        slug: true,
        ownerAddress: true,
        txHash: true,
        reservedAt: true,
      },
    });
    return row;
  } catch (err) {
    // Prisma P2002 = unique constraint failed. Extract target to know which one.
    const code = (err as { code?: unknown })?.code;
    if (code === 'P2002') {
      const target = (err as { meta?: { target?: unknown } }).meta?.target;
      // target is either an array of columns ("slug") or a string.
      const asString = Array.isArray(target) ? target.join(',') : String(target ?? '');
      if (asString.includes('tx_hash') || asString.includes('txHash')) {
        throw new TxHashTakenError(txHash);
      }
      // Default to slug collision — the more common case.
      throw new SlugTakenError(slug);
    }
    throw err;
  }
};

/**
 * List reservations owned by a given address. Bounded page size so a caller
 * cannot ask the DB for all rows. Used by a future "my VIP rooms" client
 * feature; not on the hot path today.
 */
export const listReservationsByOwner = async (
  ownerAddress: string,
  opts?: { limit?: number }
): Promise<VipReservationRow[]> => {
  const limit = Math.min(Math.max(1, opts?.limit ?? 20), 100);
  const rows = await prismaQuery.vipReservation.findMany({
    where: { ownerAddress: normalizeAddress(ownerAddress) },
    orderBy: { reservedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      slug: true,
      ownerAddress: true,
      txHash: true,
      reservedAt: true,
    },
  });
  return rows;
};
