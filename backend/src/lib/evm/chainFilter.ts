/**
 * Shared `?chainId=` query parameter parser for F10 multi-chain routes.
 *
 * Distinguishes three failure modes that ADR-009 explicitly calls out:
 *
 *   - UNSUPPORTED: chainId is malformed OR not present in chains.json.
 *     -> Routes should reply 400 CHAIN_UNSUPPORTED.
 *   - CHAIN_DISABLED: chainId is known/configured but currently disabled.
 *     -> Routes should reply 200 with empty data + `meta.warning: 'CHAIN_DISABLED'`.
 *   - OK: chainId is a known, enabled chain.
 *
 * `parseChainIdFilter` is the single source of truth for this distinction;
 * tipRoutes and leaderboardRoutes import it instead of redefining their own
 * (CODE_REVIEW W3 Must-fix #5).
 */

import { getAllConfiguredChains, getEnabledChains } from './chains.ts';

export type ChainFilterResult =
  | { kind: 'all'; chainIds: number[] }
  | { kind: 'specific'; chainIds: number[]; warning?: 'CHAIN_DISABLED' }
  | { kind: 'error'; code: 'CHAIN_UNSUPPORTED'; chainId: number };

export const parseChainIdFilter = (input: unknown): ChainFilterResult => {
  if (input === undefined || input === null || input === '') {
    return { kind: 'all', chainIds: getEnabledChains().map((c) => c.chainId) };
  }
  const s = String(input);
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) {
    // We surface `chainId: NaN` so the caller knows the input was unparseable;
    // most callers only need `code` for the error envelope.
    return { kind: 'error', code: 'CHAIN_UNSUPPORTED', chainId: Number.isFinite(n) ? n : Number.NaN };
  }

  const known = getAllConfiguredChains().some((c) => c.chainId === n);
  if (!known) return { kind: 'error', code: 'CHAIN_UNSUPPORTED', chainId: n };

  const enabled = getEnabledChains().some((c) => c.chainId === n);
  if (!enabled) return { kind: 'specific', chainIds: [n], warning: 'CHAIN_DISABLED' };

  return { kind: 'specific', chainIds: [n] };
};
