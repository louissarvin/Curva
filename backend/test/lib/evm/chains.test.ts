/**
 * F10 unit tests for the chains loader.
 *
 * Covers:
 *   - JSON load: defaults from chains.json round-trip correctly.
 *   - getEnabledChains: respects enabled flag AND filters chains with empty
 *     usdtAddress.
 *   - Env overrides: CHAIN_<id>_RPC_URLS / _USDT / _ENABLED.
 *   - getChain / getDefaultChain happy paths.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  __resetForTest,
  DEFAULT_CHAIN_ID,
  getAllConfiguredChains,
  getChain,
  getDefaultChain,
  getEnabledChains,
} from '../../../src/lib/evm/chains.ts';

// Snapshot relevant env keys so each test can mutate and we restore after.
const KEYS = [
  'CHAIN_11155111_RPC_URLS',
  'CHAIN_11155111_USDT',
  'CHAIN_11155111_ENABLED',
  'CHAIN_11155111_BLOCK_CONFIRMATIONS',
  'CHAIN_11155111_SCAN_RANGE_BLOCKS',
  'CHAIN_11155111_START_BLOCK',
  'CHAIN_9746_RPC_URLS',
  'CHAIN_9746_USDT',
  'CHAIN_9746_ENABLED',
  'SEPOLIA_RPC_URLS',
  'SEPOLIA_USDT_ADDRESS',
];

const snapshot = (): Record<string, string | undefined> => {
  const out: Record<string, string | undefined> = {};
  for (const k of KEYS) out[k] = process.env[k];
  return out;
};
const restore = (snap: Record<string, string | undefined>): void => {
  for (const k of KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
};

afterEach(() => {
  __resetForTest();
});

describe('chains loader — JSON defaults', () => {
  test('exposes both configured chains', () => {
    __resetForTest();
    const all = getAllConfiguredChains();
    const ids = all.map((c) => c.chainId).sort((a, b) => a - b);
    expect(ids).toEqual([9746, 11155111]);
  });

  test('default chain is Sepolia (11155111)', () => {
    __resetForTest();
    expect(DEFAULT_CHAIN_ID).toBe(11155111);
    expect(getDefaultChain().chainId).toBe(11155111);
  });

  test('getChain returns the requested entry or undefined', () => {
    __resetForTest();
    expect(getChain(11155111)?.name).toBe('Sepolia');
    expect(getChain(9746)?.name).toBe('Plasma Testnet');
    expect(getChain(424242)).toBeUndefined();
  });

  test('Sepolia is enabled by default; Plasma is disabled', () => {
    __resetForTest();
    const enabled = getEnabledChains();
    expect(enabled.map((c) => c.chainId)).toEqual([11155111]);
  });
});

describe('chains loader — getEnabledChains filtering', () => {
  test('skips a chain that is enabled but has an empty USDT address', () => {
    const snap = snapshot();
    try {
      process.env.CHAIN_9746_ENABLED = 'true';
      // Intentionally NOT setting CHAIN_9746_USDT — the loader should drop it.
      __resetForTest();
      const enabled = getEnabledChains();
      expect(enabled.map((c) => c.chainId)).toEqual([11155111]);
    } finally {
      restore(snap);
      __resetForTest();
    }
  });

  test('includes Plasma once both USDT + enabled are set', () => {
    const snap = snapshot();
    try {
      process.env.CHAIN_9746_ENABLED = 'true';
      process.env.CHAIN_9746_USDT = '0xAaAaaAaAaAaAaAaAAaAAaaaAAaAaAaAaaaAAAAaA';
      process.env.CHAIN_9746_RPC_URLS = 'https://testnet-rpc.plasma.to';
      __resetForTest();
      const enabled = getEnabledChains();
      const ids = enabled.map((c) => c.chainId).sort((a, b) => a - b);
      expect(ids).toEqual([9746, 11155111]);
      const plasma = enabled.find((c) => c.chainId === 9746);
      expect(plasma?.usdtAddress).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    } finally {
      restore(snap);
      __resetForTest();
    }
  });
});

describe('chains loader — env overrides', () => {
  test('CHAIN_<id>_RPC_URLS replaces the JSON-default rpc list', () => {
    const snap = snapshot();
    try {
      process.env.CHAIN_11155111_RPC_URLS = 'https://alt-rpc.example,https://alt-rpc2.example';
      __resetForTest();
      const sep = getChain(11155111);
      expect(sep?.rpcUrls).toEqual([
        'https://alt-rpc.example',
        'https://alt-rpc2.example',
      ]);
    } finally {
      restore(snap);
      __resetForTest();
    }
  });

  test('CHAIN_<id>_ENABLED=false disables the default chain', () => {
    const snap = snapshot();
    try {
      process.env.CHAIN_11155111_ENABLED = 'false';
      __resetForTest();
      const enabled = getEnabledChains();
      expect(enabled.map((c) => c.chainId)).not.toContain(11155111);
    } finally {
      restore(snap);
      __resetForTest();
    }
  });

  test('CHAIN_<id>_USDT replaces the JSON-default contract', () => {
    const snap = snapshot();
    try {
      process.env.CHAIN_11155111_USDT = '0xBBbbBBbBbBBBbBbBBBBBbBBBbBBBBBbBBbBbbBBb';
      __resetForTest();
      expect(getChain(11155111)?.usdtAddress).toBe(
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      );
    } finally {
      restore(snap);
      __resetForTest();
    }
  });

  test('legacy SEPOLIA_RPC_URLS is honored when CHAIN_11155111_RPC_URLS is unset', () => {
    const snap = snapshot();
    try {
      delete process.env.CHAIN_11155111_RPC_URLS;
      process.env.SEPOLIA_RPC_URLS = 'https://legacy.example';
      __resetForTest();
      expect(getChain(11155111)?.rpcUrls).toEqual(['https://legacy.example']);
    } finally {
      restore(snap);
      __resetForTest();
    }
  });

  test('numeric overrides parse cleanly', () => {
    const snap = snapshot();
    try {
      process.env.CHAIN_11155111_BLOCK_CONFIRMATIONS = '12';
      process.env.CHAIN_11155111_SCAN_RANGE_BLOCKS = '500';
      process.env.CHAIN_11155111_START_BLOCK = '7500000';
      __resetForTest();
      const sep = getChain(11155111);
      expect(sep?.blockConfirmations).toBe(12);
      expect(sep?.maxBlockSpan).toBe(500);
      expect(sep?.bootstrapBackfillBlocks).toBe(7500000);
    } finally {
      restore(snap);
      __resetForTest();
    }
  });
});
