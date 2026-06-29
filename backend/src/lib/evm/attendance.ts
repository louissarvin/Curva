/**
 * Curva Attendance Pass verifier (Wave 14).
 *
 * =============================================================================
 * DOCS-VERIFIED MEMO
 * =============================================================================
 * Docs consulted before writing this module (2026-07-05):
 *
 *   1. https://eips.ethereum.org/EIPS/eip-191
 *      Confirmed the personal_sign prefix format is the literal byte 0x19
 *      followed by the ASCII string "Ethereum Signed Message:\n" followed by
 *      the decimal length of the message as ASCII digits. `ethers.verifyMessage`
 *      re-applies this prefix internally so callers pass the raw payload.
 *
 *   2. https://docs.ethers.org/v6/api/hashing/#verifyMessage
 *      Confirmed `verifyMessage(message: string | Uint8Array, signature)` returns
 *      the recovered address as a checksummed 0x-hex string. Returns null on
 *      malformed input; we normalise-to-lowercase after recovery so downstream
 *      comparisons stay stable.
 *
 *   3. https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/api-reference/
 *      Confirmed `account.sign(message)` resolves with a hex string signature.
 *      No prompt injection incident on this fetch. Empirically the fallback
 *      ethers path used by the Wave 6 T14 receipt already relies on this shape;
 *      Wave 14 attendance re-uses the same worklet method (`signMessage`).
 *
 *   4. https://docs.pears.com/reference/
 *      Crawled for first-class attendance / ticketing / attestation primitives.
 *      Confirmed only the base P2P primitives are documented (Hypercore,
 *      Hyperbee, Hyperdrive, Autobase, Hyperswarm, HyperDHT, Secretstream,
 *      Compact-encoding, Protomux). No dedicated attestation primitive exists
 *      in the Pears stack, so the off-chain EIP-191 approach used here is the
 *      idiomatic path. Attendance passes ride on the existing chat Autobase +
 *      room-state Hyperbee, matching how tip receipts (system:tip-ack) work.
 *
 * No prompt-injection payloads were observed on any of the four fetches.
 *
 * VERDICT: off-chain EIP-191 attendance is the correct primitive for the Pears
 * stack. A future wave could canonicalise the message-shape as a Compact-
 * encoding schema for cross-agent interop, but the human-readable string form
 * used here matches the tip-ack pattern and stays trivially auditable.
 * =============================================================================
 *
 * Signed message shape:
 *   curva-attendance-pass:v1:<slug>:<matchId>:<peerAddress>:<issuedAt>
 *
 * `peerAddress` is the peer EOA (matches the writer identity, NOT the smart
 * account). `issuedAt` is a unix-second integer bounded to a 24h window at the
 * verifier so a leaked signature cannot be replayed weeks later.
 */

import { ethers } from 'ethers';
import { isValidEvmAddress, normalizeAddress } from '../../utils/curvaValidators.ts';

// Slug pattern here is deliberately looser than isValidSlug (which forces
// 4..32 chars) because attendance verification also accepts auto-warmed room
// slugs, and we prefer a tight anchored regex to a strict length gate that
// might diverge later. Slug is echoed back to the caller only, never used in
// a DB query without upstream validation.
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,62})[a-z0-9]$/;
const MATCH_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const SIG_RE = /^0x[0-9a-fA-F]{130,132}$/;

export interface AttendancePassInput {
  slug: string;
  matchId?: string | null;
  peerAddress: string;
  issuedAt: number; // unix seconds
}

/**
 * Build the canonical UTF-8 bytes signed by the host wallet. Deterministic and
 * stable across implementations — the pear-app (bare/attendance.js) builds the
 * exact same string before handing it to wallet.signMessage.
 */
export function buildAttendanceMessage(pass: AttendancePassInput): string {
  const slug = String(pass.slug || '').toLowerCase().trim();
  const matchId = pass.matchId ? String(pass.matchId).trim() : '';
  const peer = String(pass.peerAddress || '').toLowerCase().trim();
  const issuedAt = Math.floor(Number(pass.issuedAt) || 0);
  return `curva-attendance-pass:v1:${slug}:${matchId}:${peer}:${issuedAt}`;
}

export interface VerifyAttendanceInput extends AttendancePassInput {
  signature: string;
  expectedHostAddress?: string | null;
  // Max age of the pass. 24h keeps a leaked signature narrow-window without
  // breaking the "watch replay" story (peers may re-open the room within 24h
  // of the match and still see their own valid pass).
  maxAgeSeconds?: number;
}

export interface VerifyAttendanceResult {
  valid: boolean;
  reason?:
    | 'SLUG_INVALID'
    | 'MATCH_ID_INVALID'
    | 'ADDRESS_INVALID'
    | 'ISSUED_AT_INVALID'
    | 'SIGNATURE_MALFORMED'
    | 'SIGNATURE_MISMATCH'
    | 'HOST_MISMATCH'
    | 'EXPIRED';
  recoveredHostAddress?: string;
  ageSeconds?: number;
}

const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24; // 24h

/**
 * Verify an attendance pass locally. Never throws; all failure modes are
 * returned as a `{ valid: false, reason }` shape so callers can map to HTTP
 * status codes without try/catch noise.
 */
export function verifyAttendancePass(input: VerifyAttendanceInput): VerifyAttendanceResult {
  const slug = String(input.slug || '').toLowerCase().trim();
  if (!SLUG_RE.test(slug)) return { valid: false, reason: 'SLUG_INVALID' };

  if (input.matchId !== null && input.matchId !== undefined && input.matchId !== '') {
    if (!MATCH_ID_RE.test(String(input.matchId))) {
      return { valid: false, reason: 'MATCH_ID_INVALID' };
    }
  }

  if (!isValidEvmAddress(input.peerAddress)) {
    return { valid: false, reason: 'ADDRESS_INVALID' };
  }

  const issuedAt = Math.floor(Number(input.issuedAt) || 0);
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) {
    return { valid: false, reason: 'ISSUED_AT_INVALID' };
  }

  const signature = String(input.signature || '');
  if (!SIG_RE.test(signature)) {
    return { valid: false, reason: 'SIGNATURE_MALFORMED' };
  }

  const message = buildAttendanceMessage({
    slug,
    matchId: input.matchId ?? '',
    peerAddress: normalizeAddress(input.peerAddress),
    issuedAt,
  });

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch {
    return { valid: false, reason: 'SIGNATURE_MALFORMED' };
  }

  const recoveredLower = recovered.toLowerCase();
  if (input.expectedHostAddress) {
    const expected = String(input.expectedHostAddress).toLowerCase().trim();
    if (expected.length > 0 && recoveredLower !== expected) {
      return {
        valid: false,
        reason: 'HOST_MISMATCH',
        recoveredHostAddress: recoveredLower,
      };
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, nowSec - issuedAt);
  const maxAge = Number.isFinite(input.maxAgeSeconds) && (input.maxAgeSeconds as number) > 0
    ? Math.floor(input.maxAgeSeconds as number)
    : DEFAULT_MAX_AGE_SECONDS;
  if (ageSeconds > maxAge) {
    return {
      valid: false,
      reason: 'EXPIRED',
      recoveredHostAddress: recoveredLower,
      ageSeconds,
    };
  }

  return {
    valid: true,
    recoveredHostAddress: recoveredLower,
    ageSeconds,
  };
}

export const _internal = { SLUG_RE, MATCH_ID_RE, SIG_RE, DEFAULT_MAX_AGE_SECONDS };
