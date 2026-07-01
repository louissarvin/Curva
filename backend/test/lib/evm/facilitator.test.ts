/**
 * F11 facilitator lib tests.
 *
 * The facilitator module snapshots RELAY_SPONSOR_PK at import time. We exercise
 * the enabled/disabled state observable via the public API — enabling/disabling
 * post-import is not supported (that's the point of the boot-time snapshot).
 *
 * The submit path is exercised indirectly by the route test which injects a
 * stub sponsor via __setSponsorForTest.
 */

import { describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';
import {
  isFacilitatorEnabled,
  getSponsorAddress,
  getFacilitatorHealth,
  getMaxAmountBaseUnits,
  isTokenAllowed,
  isOnlyRegisteredHosts,
  __setSponsorForTest,
  __resetBalanceCacheForTest,
} from '../../../src/lib/evm/facilitator.ts';

describe('facilitator state (disabled by default)', () => {
  test('module snapshots default posture — facilitator disabled', () => {
    // In test env, RELAY_SPONSOR_PK is unset and RELAY_SPONSOR_ENABLED defaults
    // to false, so the module should have booted in disabled mode.
    // The __setSponsorForTest hook has NOT been called yet by any other test
    // in this file.
    expect(isFacilitatorEnabled()).toBe(false);
    expect(getSponsorAddress()).toBeNull();
  });

  test('health snapshot in disabled mode is stable', () => {
    const health = getFacilitatorHealth();
    expect(health.enabled).toBe(false);
    expect(health.sponsorAddress).toBeNull();
    expect(Array.isArray(health.balances)).toBe(true);
  });

  test('max amount cap defaults to 100 USDT in base units', () => {
    expect(getMaxAmountBaseUnits()).toBe(100_000_000n);
  });

  test('sepolia usdt is in the default allowed token list', () => {
    // Default RELAY_ALLOWED_TOKENS falls back to Sepolia USDT when env unset.
    expect(isTokenAllowed('0xd077a400968890eacc75cdc901f0356c943e4fdb')).toBe(true);
    expect(isTokenAllowed('0x0000000000000000000000000000000000000000')).toBe(false);
  });

  test('onlyRegisteredHosts defaults to true', () => {
    expect(isOnlyRegisteredHosts()).toBe(true);
  });
});

describe('facilitator with injected test sponsor', () => {
  test('__setSponsorForTest flips enabled state', () => {
    const wallet = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)));
    __setSponsorForTest(wallet);
    try {
      expect(isFacilitatorEnabled()).toBe(true);
      expect(getSponsorAddress()).toBe(wallet.address.toLowerCase());
      const health = getFacilitatorHealth();
      expect(health.enabled).toBe(true);
      expect(health.sponsorAddress).toBe(wallet.address.toLowerCase());
    } finally {
      // Restore disabled state so subsequent tests observe the default posture.
      __setSponsorForTest(null);
      __resetBalanceCacheForTest();
    }
    expect(isFacilitatorEnabled()).toBe(false);
  });
});
