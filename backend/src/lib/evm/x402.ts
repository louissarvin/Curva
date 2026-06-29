/**
 * Wave 13B - WDK x402 protocol integration.
 *
 * Docs-verification memo
 * ----------------------
 * Docs surface (WebFetched):
 *   - https://docs.wdk.tether.io/ai/x402/ (WDK): confirms EIP-3009 exact scheme
 *     as the primary path, WalletAccountEvm satisfies ClientEvmSigner, and the
 *     canonical 402 body shape: { x402Version, accepts: [{ scheme, network,
 *     maxAmountRequired, asset, resource, payTo, ... }] } served together with
 *     an X-PAYMENT-RESPONSE settlement header on success.
 *   - https://x402.org / https://docs.x402.org/: public standard confirms the
 *     402 -> sign -> retry-with-X-PAYMENT flow. Exact wire schema is at
 *     https://github.com/x402-foundation/x402 (JSON body, X-PAYMENT header
 *     carrying the signed EIP-3009 authorization).
 *   - https://eips.ethereum.org/EIPS/eip-3009: TransferWithAuthorization typed
 *     data (from, to, value, validAfter, validBefore, nonce), same struct
 *     the F11 facilitator already relays.
 *
 * Installed package availability:
 *   - No @tetherto/wdk-x402 package present in backend or pear-app
 *     node_modules at wave-13B time (searched node_modules/@tetherto).
 *
 * Chosen implementation path:
 *   - Direct wire-level implementation on top of the existing F11 facilitator
 *     (src/lib/evm/facilitator.ts) so we reuse the sponsor wallet, allowed-
 *     token gate, replay-nonce composite unique, and confirmation worker.
 *   - We emit the canonical x402 payload shape (x402Version=1, scheme='exact',
 *     network='eip155:<chainId>', maxAmountRequired, asset, resource, payTo)
 *     in a JSON body AND mirror the key fields in a X-Payment-Required
 *     response header so simple curl-based clients can consume either.
 *   - The client submits the signed authorization in an `X-Payment` request
 *     header (JSON string) which we parse, verify, and forward to
 *     submitEip3009Relay(). Fire-and-forget mode: we do NOT wait for chain
 *     confirmation before serving the resource because that would create a
 *     multi-minute paywall UX. Replay protection lives at the DB unique
 *     constraint (chainId, nonce) plus a paid-status cache keyed by peer
 *     address for 24h.
 *
 * This module is import-safe when RELAY_SPONSOR_ENABLED=false; the route
 * layer decides the response code.
 */

import { randomBytes } from 'node:crypto';
import { getChain } from './chains.ts';
import {
  fetchEip3009Domain,
  recoverEip3009Signer,
  type Eip3009Message,
  type Eip3009Signature,
} from './eip3009.ts';
import {
  isFacilitatorEnabled,
  isTokenAllowed,
  submitEip3009Relay,
  FacilitatorDisabledError,
  FacilitatorNonceUsedError,
  FacilitatorRpcError,
} from './facilitator.ts';

// EIP address + bytes32 regex validators (mirror facilitatorRoutes.ts).
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export interface X402Challenge {
  x402Version: 1;
  accepts: Array<{
    scheme: 'exact';
    network: string; // CAIP-2, e.g. 'eip155:11155111'
    maxAmountRequired: string; // decimal base-units string
    asset: string; // lowercase token contract
    resource: string; // resource path or slug
    payTo: string; // lowercase recipient address
    validAfter: number;
    validBefore: number;
    nonce: string; // 0x-prefixed 32-byte hex
    description?: string;
    mimeType?: string;
  }>;
}

export interface X402PaymentHeader {
  scheme?: 'exact';
  network?: string;
  chainId?: number;
  tokenAddress?: string;
  from: string;
  to: string;
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: string;
  v: number;
  r: string;
  s: string;
}

export interface X402SettlementResult {
  txHash: string;
  from: string; // lowercase
  network: string;
  asset: string;
  amount: string;
  nonce: string;
}

/**
 * Build a fresh x402 challenge. Caller decides the resource + validity window.
 * Nonce is a cryptographically random 32-byte hex so the client cannot
 * pre-compute or replay a prior challenge.
 */
export const buildX402Challenge = (opts: {
  chainId: number;
  tokenAddress: string;
  payTo: string;
  maxAmountRequired: string;
  resource: string;
  validForSeconds?: number;
  description?: string;
}): X402Challenge => {
  const now = Math.floor(Date.now() / 1000);
  const validFor = Math.max(60, opts.validForSeconds ?? 15 * 60);
  const nonce = '0x' + randomBytes(32).toString('hex');
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: `eip155:${opts.chainId}`,
        maxAmountRequired: opts.maxAmountRequired,
        asset: opts.tokenAddress.toLowerCase(),
        resource: opts.resource,
        payTo: opts.payTo.toLowerCase(),
        validAfter: 0,
        validBefore: now + validFor,
        nonce,
        description: opts.description,
        mimeType: 'application/json',
      },
    ],
  };
};

/**
 * Parse the X-Payment header. Accepts a raw JSON string. Returns null on any
 * malformed input; the caller sends 400 without leaking parse detail. Never
 * throws.
 */
export const parseX402PaymentHeader = (raw: unknown): X402PaymentHeader | null => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;

  // network -> chainId. Accept both eip155:<n> string form and a numeric
  // chainId directly. Fail closed if neither present.
  let chainId: number | undefined;
  if (typeof p.chainId === 'number' && Number.isInteger(p.chainId)) {
    chainId = p.chainId;
  } else if (typeof p.network === 'string') {
    const m = p.network.match(/^eip155:(\d+)$/);
    if (m) chainId = Number(m[1]);
  }
  if (chainId === undefined || !Number.isInteger(chainId) || chainId <= 0) return null;

  const tokenAddress =
    typeof p.tokenAddress === 'string'
      ? p.tokenAddress
      : typeof p.asset === 'string'
        ? p.asset
        : '';
  const from = typeof p.from === 'string' ? p.from : '';
  const to =
    typeof p.to === 'string'
      ? p.to
      : typeof p.payTo === 'string'
        ? p.payTo
        : '';
  const value =
    typeof p.value === 'string'
      ? p.value
      : typeof p.amount === 'string'
        ? p.amount
        : '';
  const validAfter = Number(p.validAfter ?? 0);
  const validBefore = Number(p.validBefore);
  const nonce = typeof p.nonce === 'string' ? p.nonce : '';
  const v = Number(p.v);
  const r = typeof p.r === 'string' ? p.r : '';
  const s = typeof p.s === 'string' ? p.s : '';

  if (!ADDR_RE.test(tokenAddress) || !ADDR_RE.test(from) || !ADDR_RE.test(to)) return null;
  if (!/^[0-9]+$/.test(value)) return null;
  if (!Number.isInteger(validAfter) || validAfter < 0) return null;
  if (!Number.isInteger(validBefore) || validBefore <= 0) return null;
  if (!BYTES32_RE.test(nonce) || !BYTES32_RE.test(r) || !BYTES32_RE.test(s)) return null;
  if (!Number.isInteger(v) || (v !== 27 && v !== 28 && v !== 0 && v !== 1)) return null;

  return {
    scheme: 'exact',
    network: `eip155:${chainId}`,
    chainId,
    tokenAddress: tokenAddress.toLowerCase(),
    from: from.toLowerCase(),
    to: to.toLowerCase(),
    value,
    validAfter,
    validBefore,
    nonce: nonce.toLowerCase(),
    v,
    r,
    s,
  };
};

/**
 * Verify that the payment header matches the challenge that was issued and
 * that the signature recovers to the claimed `from`. Returns a discriminated
 * result so the route layer can pick the right HTTP status.
 */
export type VerifyOutcome =
  | { ok: true; message: Eip3009Message; signature: Eip3009Signature; chainId: number; tokenAddress: string }
  | { ok: false; code: 'MISMATCH' | 'EXPIRED' | 'TOKEN_METADATA_UNAVAILABLE' | 'INVALID_SIGNATURE' | 'CHAIN_DISABLED' | 'TOKEN_NOT_ALLOWED'; message: string };

export const verifyX402Payment = async (
  challenge: X402Challenge,
  payment: X402PaymentHeader
): Promise<VerifyOutcome> => {
  const accept = challenge.accepts[0];
  if (!accept) return { ok: false, code: 'MISMATCH', message: 'no accept entry' };

  const expectedNetwork = accept.network;
  if (payment.network !== expectedNetwork) {
    return { ok: false, code: 'MISMATCH', message: 'network does not match challenge' };
  }
  if (payment.tokenAddress !== accept.asset) {
    return { ok: false, code: 'MISMATCH', message: 'asset does not match challenge' };
  }
  if (payment.to !== accept.payTo) {
    return { ok: false, code: 'MISMATCH', message: 'recipient does not match challenge' };
  }
  if (payment.value !== accept.maxAmountRequired) {
    return { ok: false, code: 'MISMATCH', message: 'value does not match challenge' };
  }
  if (payment.nonce !== accept.nonce.toLowerCase()) {
    return { ok: false, code: 'MISMATCH', message: 'nonce does not match challenge' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payment.validBefore <= nowSec + 30) {
    return { ok: false, code: 'EXPIRED', message: 'authorization expired or expires too soon' };
  }
  if (payment.validAfter > nowSec + 60) {
    return { ok: false, code: 'EXPIRED', message: 'authorization not yet valid' };
  }

  const chainId = payment.chainId as number;
  const chain = getChain(chainId);
  if (!chain || !chain.enabled) {
    return { ok: false, code: 'CHAIN_DISABLED', message: `chain ${chainId} not enabled` };
  }
  if (!isTokenAllowed(payment.tokenAddress)) {
    return { ok: false, code: 'TOKEN_NOT_ALLOWED', message: 'token not in allow list' };
  }

  const domain = await fetchEip3009Domain(chainId, payment.tokenAddress);
  if (!domain) {
    return { ok: false, code: 'TOKEN_METADATA_UNAVAILABLE', message: 'token EIP-712 domain unavailable' };
  }

  const eipMessage: Eip3009Message = {
    from: payment.from,
    to: payment.to,
    value: payment.value,
    validAfter: payment.validAfter,
    validBefore: payment.validBefore,
    nonce: payment.nonce,
  };
  const eipSig: Eip3009Signature = { v: payment.v, r: payment.r, s: payment.s };
  const recovered = recoverEip3009Signer(domain, eipMessage, eipSig);
  if (!recovered || recovered !== payment.from) {
    return { ok: false, code: 'INVALID_SIGNATURE', message: 'signature does not recover claimed from' };
  }

  return { ok: true, message: eipMessage, signature: eipSig, chainId, tokenAddress: payment.tokenAddress };
};

/**
 * Facade around submitEip3009Relay that surfaces classified errors the route
 * layer can distinguish (409 for replay, 400 for validation, 503 for
 * facilitator-off). Never leaks stack traces.
 */
export type SettleOutcome =
  | { ok: true; result: X402SettlementResult }
  | { ok: false; code: 'FACILITATOR_DISABLED' | 'NONCE_USED' | 'RPC_FAILED'; message: string };

export const settleX402Payment = async (
  chainId: number,
  tokenAddress: string,
  message: Eip3009Message,
  signature: Eip3009Signature
): Promise<SettleOutcome> => {
  if (!isFacilitatorEnabled()) {
    return { ok: false, code: 'FACILITATOR_DISABLED', message: 'x402 requires the EIP-3009 facilitator' };
  }
  try {
    const relay = await submitEip3009Relay({
      chainId,
      tokenAddress,
      message,
      signature,
    });
    return {
      ok: true,
      result: {
        txHash: relay.txHash,
        from: message.from,
        network: `eip155:${chainId}`,
        asset: tokenAddress,
        amount: message.value,
        nonce: message.nonce,
      },
    };
  } catch (err) {
    if (err instanceof FacilitatorDisabledError) {
      return { ok: false, code: 'FACILITATOR_DISABLED', message: 'facilitator disabled' };
    }
    if (err instanceof FacilitatorNonceUsedError) {
      return { ok: false, code: 'NONCE_USED', message: 'authorization nonce already used' };
    }
    if (err instanceof FacilitatorRpcError) {
      return { ok: false, code: 'RPC_FAILED', message: 'on-chain submit failed' };
    }
    return { ok: false, code: 'RPC_FAILED', message: 'unexpected settlement failure' };
  }
};

// =============================================================================
// In-memory unlock cache — a peer that successfully paid gets serviced for
// UNLOCK_TTL_MS without re-paying. Keyed by (resource, peerAddress).
// =============================================================================

interface UnlockEntry {
  paidAt: number;
  txHash: string;
  expiresAt: number;
}

const UNLOCKS = new Map<string, UnlockEntry>();
const UNLOCK_TTL_MS = 24 * 60 * 60 * 1000;
// Hard cap prevents unbounded growth under scraping.
const MAX_UNLOCKS = 10_000;

const unlockKey = (resource: string, peer: string): string =>
  `${resource}::${peer.toLowerCase()}`;

const purgeExpired = (): void => {
  if (UNLOCKS.size < MAX_UNLOCKS / 2) return;
  const now = Date.now();
  for (const [k, v] of UNLOCKS) {
    if (v.expiresAt <= now) UNLOCKS.delete(k);
    if (UNLOCKS.size < MAX_UNLOCKS / 2) break;
  }
};

export const grantUnlock = (resource: string, peer: string, txHash: string): void => {
  purgeExpired();
  if (UNLOCKS.size >= MAX_UNLOCKS) {
    // Evict oldest — simple LRU-lite behavior. Fine for demo scale.
    const oldestKey = UNLOCKS.keys().next().value;
    if (oldestKey) UNLOCKS.delete(oldestKey);
  }
  UNLOCKS.set(unlockKey(resource, peer), {
    paidAt: Date.now(),
    expiresAt: Date.now() + UNLOCK_TTL_MS,
    txHash,
  });
};

export const isUnlocked = (resource: string, peer: string): { unlocked: boolean; txHash: string | null } => {
  const entry = UNLOCKS.get(unlockKey(resource, peer));
  if (!entry) return { unlocked: false, txHash: null };
  if (entry.expiresAt <= Date.now()) {
    UNLOCKS.delete(unlockKey(resource, peer));
    return { unlocked: false, txHash: null };
  }
  return { unlocked: true, txHash: entry.txHash };
};

// Test-only reset.
export const __resetUnlocksForTest = (): void => {
  UNLOCKS.clear();
};
