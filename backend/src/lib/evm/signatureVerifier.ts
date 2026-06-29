import { ethers } from 'ethers';

/**
 * EIP-191 personal_sign verification.
 *
 * The host signs `'curva-delete:' + slug + ':' + challenge` with their host smart-account
 * owner key via WDK (`account.sign(...)`). We recover the address and compare.
 *
 * For v1 we accept EIP-191 ECDSA from the underlying owner key of the host's WDK Safe.
 * If WDK ships ERC-1271-only signing later, swap this single function for an on-chain
 * `isValidSignature(bytes32, bytes)` call against `claimedAddress`.
 */
export const verifyEip191Signature = (
  message: string,
  signature: string,
  claimedAddress: string
): boolean => {
  try {
    if (typeof message !== 'string' || message.length === 0) return false;
    if (typeof signature !== 'string' || !/^0x[a-fA-F0-9]+$/.test(signature)) return false;
    if (typeof claimedAddress !== 'string' || !ethers.isAddress(claimedAddress)) return false;

    const recovered = ethers.verifyMessage(message, signature);
    // Compare lowercase to avoid checksum-case mismatch.
    return recovered.toLowerCase() === claimedAddress.toLowerCase();
  } catch {
    return false;
  }
};

/**
 * Build the canonical message that hosts must sign to delete a room.
 * Format: `curva-delete:<slug>:<challenge>`
 *
 * Keeping the prefix constant so the frontend can hard-code it and we can
 * never accidentally accept a signature for a different action.
 */
export const buildDeleteChallengeMessage = (slug: string, challenge: string): string =>
  `curva-delete:${slug}:${challenge}`;

/**
 * Tip-ack signature helper (Wave 6 future infrastructure).
 *
 * When the pear-app publishes `system:tip-ack`, the tipper's WDK owner key
 * signs `Curva tip receipt: <txHash> at <timestamp>` via EIP-191 personal_sign.
 * A future `/wdk/verify-ack` endpoint will call this helper to prove the tip
 * receipt shown in the room was authored by the tipper key on-record, not
 * spoofed by a peer relaying somebody else's txHash.
 *
 * Not wired into any route yet. Kept alongside the delete helper so the
 * canonical message strings live in one file — grep-friendly for auditors.
 */
export const buildTipAckMessage = (txHash: string, timestamp: number | string): string =>
  `Curva tip receipt: ${txHash} at ${timestamp}`;

/**
 * Verify an EIP-191 personal_sign of the canonical tip-ack message.
 * Returns true only when the recovered address matches `expectedSigner`
 * (case-insensitive). Any malformed input yields false so callers cannot
 * distinguish "bad shape" from "wrong signer" — reduces oracle risk.
 */
export const verifyTipAckSignature = (params: {
  txHash: string;
  timestamp: number | string;
  signature: string;
  expectedSigner: string;
}): boolean => {
  const { txHash, timestamp, signature, expectedSigner } = params;
  if (typeof txHash !== 'string' || txHash.length === 0) return false;
  if (
    typeof timestamp !== 'number' &&
    !(typeof timestamp === 'string' && timestamp.length > 0)
  ) {
    return false;
  }
  const message = buildTipAckMessage(txHash, timestamp);
  return verifyEip191Signature(message, signature, expectedSigner);
};
