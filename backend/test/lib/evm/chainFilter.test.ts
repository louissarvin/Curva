/**
 * Unit tests for the shared `?chainId=` parser (CODE_REVIEW W3 Must-fix #5).
 *
 * The parser must distinguish UNSUPPORTED (malformed or unknown -> 400) from
 * CHAIN_DISABLED (known-but-disabled -> 200 + meta.warning) per ADR-009.
 */

import { describe, expect, test } from 'bun:test';
import { parseChainIdFilter } from '../../../src/lib/evm/chainFilter.ts';

describe('parseChainIdFilter', () => {
  test("kind:'all' when input is omitted/empty/null", () => {
    const omitted = parseChainIdFilter(undefined);
    expect(omitted.kind).toBe('all');
    expect(omitted.kind === 'all' && Array.isArray(omitted.chainIds)).toBe(true);

    const nullInput = parseChainIdFilter(null);
    expect(nullInput.kind).toBe('all');

    const empty = parseChainIdFilter('');
    expect(empty.kind).toBe('all');
  });

  test("kind:'specific' for a known, enabled chainId (Sepolia 11155111)", () => {
    const result = parseChainIdFilter(11155111);
    expect(result.kind).toBe('specific');
    if (result.kind !== 'specific') throw new Error('type narrowing failed');
    expect(result.chainIds).toEqual([11155111]);
    expect(result.warning).toBeUndefined();
  });

  test("kind:'specific' with warning CHAIN_DISABLED for a configured-but-disabled chain (Plasma 9746)", () => {
    const result = parseChainIdFilter(9746);
    expect(result.kind).toBe('specific');
    if (result.kind !== 'specific') throw new Error('type narrowing failed');
    expect(result.chainIds).toEqual([9746]);
    expect(result.warning).toBe('CHAIN_DISABLED');
  });

  test("kind:'error' CHAIN_UNSUPPORTED for an unknown chainId", () => {
    const result = parseChainIdFilter(99999);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('type narrowing failed');
    expect(result.code).toBe('CHAIN_UNSUPPORTED');
    expect(result.chainId).toBe(99999);
  });

  test("kind:'error' CHAIN_UNSUPPORTED for non-integer input", () => {
    const garbage = parseChainIdFilter('not-a-number');
    expect(garbage.kind).toBe('error');

    const decimal = parseChainIdFilter('1.5');
    expect(decimal.kind).toBe('error');

    const negative = parseChainIdFilter('-1');
    expect(negative.kind).toBe('error');

    const zero = parseChainIdFilter('0');
    expect(zero.kind).toBe('error');
  });

  test('accepts numeric string for a known chainId', () => {
    const result = parseChainIdFilter('11155111');
    expect(result.kind).toBe('specific');
    if (result.kind !== 'specific') throw new Error('type narrowing failed');
    expect(result.chainIds).toEqual([11155111]);
  });
});
