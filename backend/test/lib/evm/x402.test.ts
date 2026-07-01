/**
 * Wave 13B unit tests for src/lib/evm/x402.ts.
 *
 * Covers the pure helpers (challenge build, header parse, verify) without the
 * HTTP route boundary. Route-level tests live in test/routes/x402.test.ts.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { ethers } from 'ethers';

import {
  buildX402Challenge,
  parseX402PaymentHeader,
  grantUnlock,
  isUnlocked,
  __resetUnlocksForTest,
} from '../../../src/lib/evm/x402.ts';

const TOKEN = '0xd077a400968890eacc75cdc901f0356c943e4fdb';
const PAY_TO = '0x' + '77'.repeat(20);
const CHAIN_ID = 11155111;

afterEach(() => {
  __resetUnlocksForTest();
});

describe('buildX402Challenge', () => {
  test('emits canonical x402 shape with all required fields', () => {
    const challenge = buildX402Challenge({
      chainId: CHAIN_ID,
      tokenAddress: TOKEN,
      payTo: PAY_TO,
      maxAmountRequired: '1000000',
      resource: 'premium-translations',
    });
    expect(challenge.x402Version).toBe(1);
    expect(challenge.accepts.length).toBe(1);
    const a = challenge.accepts[0]!;
    expect(a.scheme).toBe('exact');
    expect(a.network).toBe('eip155:11155111');
    expect(a.asset).toBe(TOKEN.toLowerCase());
    expect(a.payTo).toBe(PAY_TO.toLowerCase());
    expect(a.maxAmountRequired).toBe('1000000');
    expect(a.resource).toBe('premium-translations');
    expect(a.validAfter).toBe(0);
    expect(a.validBefore).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(a.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('two challenges have distinct nonces', () => {
    const a = buildX402Challenge({ chainId: CHAIN_ID, tokenAddress: TOKEN, payTo: PAY_TO, maxAmountRequired: '1000000', resource: 'r' });
    const b = buildX402Challenge({ chainId: CHAIN_ID, tokenAddress: TOKEN, payTo: PAY_TO, maxAmountRequired: '1000000', resource: 'r' });
    expect(a.accepts[0]!.nonce).not.toBe(b.accepts[0]!.nonce);
  });
});

describe('parseX402PaymentHeader', () => {
  const validHeader = (overrides: Record<string, unknown> = {}): string => {
    const base = {
      network: 'eip155:11155111',
      tokenAddress: TOKEN,
      from: '0x' + 'aa'.repeat(20),
      to: PAY_TO,
      value: '1000000',
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 900,
      nonce: '0x' + 'cc'.repeat(32),
      v: 27,
      r: '0x' + 'dd'.repeat(32),
      s: '0x' + 'ee'.repeat(32),
    };
    return JSON.stringify({ ...base, ...overrides });
  };

  test('accepts a well-formed header', () => {
    const parsed = parseX402PaymentHeader(validHeader());
    expect(parsed).not.toBeNull();
    expect(parsed?.chainId).toBe(11155111);
    expect(parsed?.tokenAddress).toBe(TOKEN.toLowerCase());
  });

  test('rejects non-string input', () => {
    expect(parseX402PaymentHeader(null)).toBeNull();
    expect(parseX402PaymentHeader(42)).toBeNull();
    expect(parseX402PaymentHeader({})).toBeNull();
  });

  test('rejects invalid JSON', () => {
    expect(parseX402PaymentHeader('{not json')).toBeNull();
  });

  test('rejects malformed nonce', () => {
    expect(parseX402PaymentHeader(validHeader({ nonce: '0xnope' }))).toBeNull();
  });

  test('rejects malformed address', () => {
    expect(parseX402PaymentHeader(validHeader({ from: 'not-an-addr' }))).toBeNull();
  });

  test('rejects non-decimal value', () => {
    expect(parseX402PaymentHeader(validHeader({ value: 'lots' }))).toBeNull();
  });

  test('rejects unknown v', () => {
    expect(parseX402PaymentHeader(validHeader({ v: 99 }))).toBeNull();
  });

  test('accepts chainId numeric form (no network string)', () => {
    const parsed = parseX402PaymentHeader(
      JSON.stringify({
        chainId: 11155111,
        tokenAddress: TOKEN,
        from: '0x' + 'aa'.repeat(20),
        to: PAY_TO,
        value: '1000000',
        validAfter: 0,
        validBefore: Math.floor(Date.now() / 1000) + 900,
        nonce: '0x' + 'cc'.repeat(32),
        v: 27,
        r: '0x' + 'dd'.repeat(32),
        s: '0x' + 'ee'.repeat(32),
      })
    );
    expect(parsed?.chainId).toBe(11155111);
  });

  test('rejects overlong input (DoS guard)', () => {
    const big = 'x'.repeat(9000);
    expect(parseX402PaymentHeader(big)).toBeNull();
  });
});

describe('unlock cache', () => {
  test('grantUnlock then isUnlocked returns true with txHash', () => {
    const peer = '0x' + 'ab'.repeat(20);
    grantUnlock('resource-x', peer, '0xtx');
    const state = isUnlocked('resource-x', peer);
    expect(state.unlocked).toBe(true);
    expect(state.txHash).toBe('0xtx');
  });

  test('isUnlocked case-insensitive on peer address', () => {
    const peer = '0x' + 'ab'.repeat(20);
    grantUnlock('resource-x', peer, '0xtx');
    expect(isUnlocked('resource-x', peer.toUpperCase()).unlocked).toBe(true);
  });

  test('different resource is separately gated', () => {
    const peer = '0x' + 'ab'.repeat(20);
    grantUnlock('resource-x', peer, '0xtx');
    expect(isUnlocked('resource-y', peer).unlocked).toBe(false);
  });
});
