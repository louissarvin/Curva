import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import {
  buildDeleteChallengeMessage,
  buildTipAckMessage,
  verifyEip191Signature,
  verifyTipAckSignature,
} from '../../src/lib/evm/signatureVerifier.ts';

describe('verifyEip191Signature', () => {
  test('verifies a freshly signed message', async () => {
    const wallet = ethers.Wallet.createRandom();
    const message = buildDeleteChallengeMessage('demo-room', 'challenge123');
    const signature = await wallet.signMessage(message);

    expect(verifyEip191Signature(message, signature, wallet.address)).toBe(true);
  });

  test('rejects signature from wrong key', async () => {
    const wallet = ethers.Wallet.createRandom();
    const other = ethers.Wallet.createRandom();
    const message = buildDeleteChallengeMessage('demo-room', 'challenge123');
    const signature = await wallet.signMessage(message);

    expect(verifyEip191Signature(message, signature, other.address)).toBe(false);
  });

  test('rejects signature for different message', async () => {
    const wallet = ethers.Wallet.createRandom();
    const signature = await wallet.signMessage('different message');
    const message = buildDeleteChallengeMessage('demo-room', 'challenge123');

    expect(verifyEip191Signature(message, signature, wallet.address)).toBe(false);
  });

  test('rejects malformed signature', () => {
    const wallet = ethers.Wallet.createRandom();
    expect(verifyEip191Signature('hello', 'not-hex', wallet.address)).toBe(false);
    expect(verifyEip191Signature('hello', '0xdead', wallet.address)).toBe(false);
  });

  test('case-insensitive address compare', async () => {
    const wallet = ethers.Wallet.createRandom();
    const message = buildDeleteChallengeMessage('demo', 'xyz');
    const sig = await wallet.signMessage(message);
    expect(verifyEip191Signature(message, sig, wallet.address.toLowerCase())).toBe(true);
    expect(verifyEip191Signature(message, sig, wallet.address.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  // EOA-vs-Safe coverage: the delete-flow rule is "recover against the OWNER EOA,
  // not the smart-account address". This test pins that contract.
  test('owner EOA recovery happy path', async () => {
    const ownerEoa = ethers.Wallet.createRandom();
    // A separate, unrelated smart-account address (would be the Safe's address
    // in production). Recovery must compare to the owner EOA, not this one.
    const smartAccount = ethers.Wallet.createRandom().address;
    const message = buildDeleteChallengeMessage('safe-room', 'chal-9001');
    const sig = await ownerEoa.signMessage(message);

    // Verifying against the owner EOA succeeds.
    expect(verifyEip191Signature(message, sig, ownerEoa.address)).toBe(true);
    // Verifying against the smart-account address (the historical bug) fails.
    expect(verifyEip191Signature(message, sig, smartAccount)).toBe(false);
  });
});

describe('buildDeleteChallengeMessage', () => {
  test('canonical format', () => {
    expect(buildDeleteChallengeMessage('slug', 'chal')).toBe('curva-delete:slug:chal');
  });
});

describe('buildTipAckMessage / verifyTipAckSignature (Wave 6)', () => {
  const txHash = '0x' + 'aa'.repeat(32);
  const timestamp = 1735689600; // 2025-01-01T00:00:00Z

  test('canonical message format', () => {
    expect(buildTipAckMessage(txHash, timestamp)).toBe(
      `Curva tip receipt: ${txHash} at ${timestamp}`
    );
  });

  test('accepts a valid EIP-191 signature from the tipper', async () => {
    const tipper = ethers.Wallet.createRandom();
    const message = buildTipAckMessage(txHash, timestamp);
    const signature = await tipper.signMessage(message);

    expect(
      verifyTipAckSignature({
        txHash,
        timestamp,
        signature,
        expectedSigner: tipper.address,
      })
    ).toBe(true);
  });

  test('rejects a signature from a different signer', async () => {
    const tipper = ethers.Wallet.createRandom();
    const impostor = ethers.Wallet.createRandom();
    const message = buildTipAckMessage(txHash, timestamp);
    const signature = await tipper.signMessage(message);

    expect(
      verifyTipAckSignature({
        txHash,
        timestamp,
        signature,
        expectedSigner: impostor.address,
      })
    ).toBe(false);
  });

  test('rejects when the txHash was tampered', async () => {
    const tipper = ethers.Wallet.createRandom();
    const message = buildTipAckMessage(txHash, timestamp);
    const signature = await tipper.signMessage(message);

    expect(
      verifyTipAckSignature({
        txHash: '0x' + 'bb'.repeat(32),
        timestamp,
        signature,
        expectedSigner: tipper.address,
      })
    ).toBe(false);
  });

  test('rejects malformed inputs without throwing', () => {
    const wallet = ethers.Wallet.createRandom();
    expect(
      verifyTipAckSignature({
        txHash: '',
        timestamp,
        signature: '0xdead',
        expectedSigner: wallet.address,
      })
    ).toBe(false);
    expect(
      verifyTipAckSignature({
        txHash,
        timestamp: '',
        signature: '0xdead',
        expectedSigner: wallet.address,
      })
    ).toBe(false);
  });
});
