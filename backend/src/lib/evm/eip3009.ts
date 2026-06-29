/**
 * F11 EIP-3009 helper — typed-data verification + per-token EIP-712 domain
 * discovery.
 *
 * Reference: https://eips.ethereum.org/EIPS/eip-3009
 *
 *   TransferWithAuthorization(
 *     address from,
 *     address to,
 *     uint256 value,
 *     uint256 validAfter,
 *     uint256 validBefore,
 *     bytes32 nonce
 *   )
 *
 * The signature is EIP-712 with the token contract's EIP712Domain
 * (name/version/chainId/verifyingContract). We use `ethers.verifyTypedData` to
 * recover the signer and compare it to the claimed `from`.
 *
 * Domain lookup: every EIP-3009 token exposes `name()` and either `EIP712_VERSION()`
 * or a `version()` view. Some deployments hard-code "1" for the version. We
 * probe in this order and cache the result per (chainId, tokenAddress) so we
 * do at most one RPC roundtrip per token lifetime.
 *
 * Notes:
 * - The domain lookup is best-effort. If both probes fail, the token is treated
 *   as unusable and the facilitator returns 503 TOKEN_METADATA_UNAVAILABLE for
 *   that chain. Other chains continue to work.
 * - This module never logs the sponsor PK or the signature secrets. Recovery is
 *   pure math over the message; no side effects.
 */

import { ethers } from 'ethers';
import { getChain, type ChainConfig } from './chains.ts';
import { withProviderForChain } from './provider.ts';

// =============================================================================
// Types
// =============================================================================

export interface Eip3009Message {
  from: string; // 0x... lowercase EVM address
  to: string; // 0x... lowercase EVM address
  value: string; // decimal string, base units
  validAfter: number; // unix seconds
  validBefore: number; // unix seconds
  nonce: string; // 0x... 64-hex bytes32
}

export interface Eip3009Signature {
  v: number;
  r: string; // 0x... 64-hex bytes32
  s: string; // 0x... 64-hex bytes32
}

export interface Eip3009Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string; // lowercase 0x...
}

// EIP-712 types object shared by every EIP-3009 verify. Frozen so callers
// cannot mutate the singleton by accident.
export const EIP3009_TYPES: Readonly<
  Record<string, ReadonlyArray<{ readonly name: string; readonly type: string }>>
> = Object.freeze({
  TransferWithAuthorization: Object.freeze([
    Object.freeze({ name: 'from', type: 'address' }),
    Object.freeze({ name: 'to', type: 'address' }),
    Object.freeze({ name: 'value', type: 'uint256' }),
    Object.freeze({ name: 'validAfter', type: 'uint256' }),
    Object.freeze({ name: 'validBefore', type: 'uint256' }),
    Object.freeze({ name: 'nonce', type: 'bytes32' }),
  ]) as ReadonlyArray<{ readonly name: string; readonly type: string }>,
});

// Minimal ABI for the domain-discovery probes and the transfer call itself.
export const EIP3009_TOKEN_ABI = [
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function EIP712_VERSION() view returns (string)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external',
] as const;

// =============================================================================
// Signature recovery
// =============================================================================

/**
 * Recover the signer address from an EIP-3009 signature. Returns lowercase
 * 0x... on success, `null` on any malformed input (never throws, never leaks
 * ethers error messages).
 */
export const recoverEip3009Signer = (
  domain: Eip3009Domain,
  message: Eip3009Message,
  sig: Eip3009Signature
): string | null => {
  try {
    // Validate signature shape before invoking ethers to keep error surface tight.
    if (typeof sig.v !== 'number' || !Number.isInteger(sig.v)) return null;
    if (typeof sig.r !== 'string' || !/^0x[0-9a-f]{64}$/i.test(sig.r)) return null;
    if (typeof sig.s !== 'string' || !/^0x[0-9a-f]{64}$/i.test(sig.s)) return null;

    // Serialize {v, r, s} into a 65-byte 0x... signature that verifyTypedData
    // accepts. ethers.Signature.from normalizes v (27/28 vs 0/1) automatically.
    const joinedSig = ethers.Signature.from({ v: sig.v, r: sig.r, s: sig.s }).serialized;

    // ethers.verifyTypedData mutates neither its arguments nor global state.
    const recovered = ethers.verifyTypedData(
      {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract,
      },
      // Cast: ethers accepts a plain record; the frozen readonly type on our
      // singleton is stricter than what ethers is willing to accept at compile
      // time. The runtime shape is identical.
      EIP3009_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
      {
        from: message.from,
        to: message.to,
        value: message.value,
        validAfter: message.validAfter,
        validBefore: message.validBefore,
        nonce: message.nonce,
      },
      joinedSig
    );
    return recovered.toLowerCase();
  } catch {
    return null;
  }
};

// =============================================================================
// Domain discovery + cache
// =============================================================================

interface CacheEntry {
  domain: Eip3009Domain | null; // null after a failed probe; treated as unusable
  probedAt: number;
}

const DOMAIN_CACHE = new Map<string, CacheEntry>();
// If a token failed the probe (returned no name/version) we still cache the
// failure but with a shorter TTL so the next boot doesn't hard-fail for good.
const NEGATIVE_CACHE_TTL_MS = 60_000;

const cacheKey = (chainId: number, tokenAddress: string): string =>
  `${chainId}:${tokenAddress.toLowerCase()}`;

/**
 * Probe the token contract's name + version to build the EIP-712 domain.
 * Returns `null` if the probe fails (bad ABI, non-EIP-3009 token, RPC error).
 * Cached per (chainId, tokenAddress).
 */
export const fetchEip3009Domain = async (
  chainId: number,
  tokenAddress: string
): Promise<Eip3009Domain | null> => {
  const key = cacheKey(chainId, tokenAddress);
  const cached = DOMAIN_CACHE.get(key);
  if (cached) {
    if (cached.domain !== null) return cached.domain;
    // Negative cache TTL — retry after the window.
    if (Date.now() - cached.probedAt < NEGATIVE_CACHE_TTL_MS) return null;
  }

  const chain = getChain(chainId);
  if (!chain || !chain.enabled) {
    DOMAIN_CACHE.set(key, { domain: null, probedAt: Date.now() });
    return null;
  }

  const lowered = tokenAddress.toLowerCase();
  let domain: Eip3009Domain | null = null;
  try {
    domain = await withProviderForChain(chain, async (provider) => {
      const contract = new ethers.Contract(lowered, EIP3009_TOKEN_ABI, provider);
      // name() is required. If this throws the token is not usable.
      const name = await contract.name();
      // Try EIP712_VERSION first (Circle USDC pattern), then version(), then '1'.
      let version = '1';
      try {
        version = await contract.EIP712_VERSION();
      } catch {
        try {
          version = await contract.version();
        } catch {
          version = '1';
        }
      }
      return {
        name: String(name),
        version: String(version),
        chainId,
        verifyingContract: lowered,
      } satisfies Eip3009Domain;
    });
  } catch (err) {
    console.warn(
      `[eip3009] domain probe failed for chain=${chainId} token=${lowered}: ${
        (err as Error)?.message ?? String(err)
      }`
    );
    domain = null;
  }

  DOMAIN_CACHE.set(key, { domain, probedAt: Date.now() });
  return domain;
};

/**
 * Test-only: drop the domain cache so a re-probe happens on next request.
 * Never call from production code.
 */
export const __resetForTest = (): void => {
  DOMAIN_CACHE.clear();
};

// Re-export for callers that only need the chain type.
export type { ChainConfig };
