/**
 * F11 EIP-3009 signature recovery unit tests.
 *
 * Exercises the pure math path (recoverEip3009Signer) with real ethers
 * signatures — no RPC calls, no DB. Domain lookup is covered separately.
 */

import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import {
  recoverEip3009Signer,
  EIP3009_TYPES,
  type Eip3009Domain,
  type Eip3009Message,
} from '../../../src/lib/evm/eip3009.ts';

const DOMAIN: Eip3009Domain = {
  name: 'USDT',
  version: '1',
  chainId: 11155111,
  verifyingContract: '0xd077a400968890eacc75cdc901f0356c943e4fdb',
};

const signMessage = async (
  wallet: ethers.HDNodeWallet,
  domain: Eip3009Domain,
  message: Eip3009Message
) => {
  const sig = await wallet.signTypedData(
    {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    EIP3009_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    {
      from: message.from,
      to: message.to,
      value: message.value,
      validAfter: message.validAfter,
      validBefore: message.validBefore,
      nonce: message.nonce,
    }
  );
  const parsed = ethers.Signature.from(sig);
  return { v: parsed.v, r: parsed.r, s: parsed.s };
};

const nonceHex = (): string => ethers.hexlify(ethers.randomBytes(32));

describe('recoverEip3009Signer', () => {
  test('valid signature recovers the expected signer', async () => {
    const wallet = ethers.Wallet.createRandom();
    const to = ethers.Wallet.createRandom().address.toLowerCase();
    const message: Eip3009Message = {
      from: wallet.address.toLowerCase(),
      to,
      value: '1000000',
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      nonce: nonceHex(),
    };
    const sig = await signMessage(wallet, DOMAIN, message);
    const recovered = recoverEip3009Signer(DOMAIN, message, sig);
    expect(recovered).toBe(wallet.address.toLowerCase());
  });

  test('tampering with value produces a different recovery', async () => {
    const wallet = ethers.Wallet.createRandom();
    const message: Eip3009Message = {
      from: wallet.address.toLowerCase(),
      to: '0x' + '11'.repeat(20),
      value: '5000000',
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      nonce: nonceHex(),
    };
    const sig = await signMessage(wallet, DOMAIN, message);
    const tampered: Eip3009Message = { ...message, value: '5000001' };
    const recovered = recoverEip3009Signer(DOMAIN, tampered, sig);
    // Recovery still returns some address, just not the signer.
    expect(recovered).not.toBe(wallet.address.toLowerCase());
  });

  test('tampering with the domain (chainId) breaks recovery', async () => {
    const wallet = ethers.Wallet.createRandom();
    const message: Eip3009Message = {
      from: wallet.address.toLowerCase(),
      to: '0x' + '22'.repeat(20),
      value: '2000000',
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      nonce: nonceHex(),
    };
    const sig = await signMessage(wallet, DOMAIN, message);
    const otherDomain: Eip3009Domain = { ...DOMAIN, chainId: 1 }; // wrong chain
    const recovered = recoverEip3009Signer(otherDomain, message, sig);
    expect(recovered).not.toBe(wallet.address.toLowerCase());
  });

  test('malformed r returns null', async () => {
    const wallet = ethers.Wallet.createRandom();
    const message: Eip3009Message = {
      from: wallet.address.toLowerCase(),
      to: '0x' + '33'.repeat(20),
      value: '1000000',
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      nonce: nonceHex(),
    };
    const recovered = recoverEip3009Signer(DOMAIN, message, {
      v: 27,
      r: 'not-hex',
      s: '0x' + 'aa'.repeat(32),
    });
    expect(recovered).toBeNull();
  });

  test('non-integer v returns null', async () => {
    const message: Eip3009Message = {
      from: '0x' + '11'.repeat(20),
      to: '0x' + '22'.repeat(20),
      value: '1',
      validAfter: 0,
      validBefore: 1,
      nonce: nonceHex(),
    };
    const recovered = recoverEip3009Signer(DOMAIN, message, {
      v: 27.5 as unknown as number,
      r: '0x' + 'aa'.repeat(32),
      s: '0x' + 'bb'.repeat(32),
    });
    expect(recovered).toBeNull();
  });

  test('empty sig fields return null', () => {
    const message: Eip3009Message = {
      from: '0x' + '11'.repeat(20),
      to: '0x' + '22'.repeat(20),
      value: '1',
      validAfter: 0,
      validBefore: 1,
      nonce: nonceHex(),
    };
    const recovered = recoverEip3009Signer(DOMAIN, message, {
      v: 27,
      r: '',
      s: '',
    });
    expect(recovered).toBeNull();
  });
});
