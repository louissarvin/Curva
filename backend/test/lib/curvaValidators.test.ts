import { describe, expect, test } from 'bun:test';
import {
  isValidSlug,
  isValidEvmAddress,
  isValidHostHandle,
  isValidPearLink,
  isValidTeamCode,
  isValidMatchStage,
  isValidCuid,
  parseBoundedInt,
  normalizeSlug,
  normalizeAddress,
  sanitizeHostHandle,
} from '../../src/utils/curvaValidators.ts';

describe('isValidSlug', () => {
  test('accepts valid slugs', () => {
    expect(isValidSlug('arg-vs-ita-r16')).toBe(true);
    expect(isValidSlug('abcd')).toBe(true);
    expect(isValidSlug('a1b2c3d4')).toBe(true);
  });
  test('rejects too short / too long', () => {
    expect(isValidSlug('abc')).toBe(false);
    expect(isValidSlug('a'.repeat(33))).toBe(false);
  });
  test('rejects invalid chars', () => {
    expect(isValidSlug('Has-Caps')).toBe(false);
    expect(isValidSlug('-leading')).toBe(false);
    expect(isValidSlug('trailing-')).toBe(false);
    expect(isValidSlug('white space')).toBe(false);
    expect(isValidSlug('emoji😀here')).toBe(false);
  });
});

describe('isValidEvmAddress', () => {
  test('accepts checksum and lowercase', () => {
    expect(isValidEvmAddress('0xd8da6bf26964af9d7eed9e03e53415d37aa96045')).toBe(true);
    expect(isValidEvmAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(true);
  });
  test('rejects malformed', () => {
    expect(isValidEvmAddress('not-an-address')).toBe(false);
    expect(isValidEvmAddress('0x123')).toBe(false);
    expect(isValidEvmAddress('')).toBe(false);
    expect(isValidEvmAddress(null)).toBe(false);
  });
});

describe('isValidHostHandle', () => {
  test('happy path', () => {
    expect(isValidHostHandle('curva-host')).toBe(true);
    expect(isValidHostHandle('h')).toBe(true);
  });
  test('rejects control chars', () => {
    expect(isValidHostHandle('hello\x00world')).toBe(false);
    expect(isValidHostHandle('hello\nworld')).toBe(false);
  });
  test('rejects too long', () => {
    expect(isValidHostHandle('h'.repeat(33))).toBe(false);
  });
});

describe('isValidPearLink', () => {
  test('accepts pear:// URLs', () => {
    expect(isValidPearLink('pear://curva?room=demo')).toBe(true);
  });
  test('rejects non-pear', () => {
    expect(isValidPearLink('https://example.com')).toBe(false);
    expect(isValidPearLink('pearblah')).toBe(false);
  });
});

describe('isValidTeamCode', () => {
  test('only accepts 3 uppercase letters', () => {
    expect(isValidTeamCode('ARG')).toBe(true);
    expect(isValidTeamCode('arg')).toBe(false);
    expect(isValidTeamCode('AR')).toBe(false);
    expect(isValidTeamCode('ARGS')).toBe(false);
  });
});

describe('isValidMatchStage', () => {
  test('enum membership', () => {
    expect(isValidMatchStage('group')).toBe(true);
    expect(isValidMatchStage('final')).toBe(true);
    expect(isValidMatchStage('bogus')).toBe(false);
  });
});

describe('isValidCuid', () => {
  test('basic shape', () => {
    expect(isValidCuid('c' + 'a'.repeat(24))).toBe(true);
    expect(isValidCuid('not-a-cuid')).toBe(false);
  });
});

describe('parseBoundedInt', () => {
  test('clamps to range', () => {
    expect(parseBoundedInt('5', 1, 10, 3)).toBe(5);
    expect(parseBoundedInt('99', 1, 10, 3)).toBe(10);
    expect(parseBoundedInt('-1', 1, 10, 3)).toBe(1);
    expect(parseBoundedInt('abc', 1, 10, 3)).toBe(3);
    expect(parseBoundedInt(undefined, 1, 10, 3)).toBe(3);
  });
});

describe('normalize helpers', () => {
  test('normalizeSlug lowercases and trims', () => {
    expect(normalizeSlug('  HELLO-world  ')).toBe('hello-world');
  });
  test('normalizeAddress lowercases', () => {
    expect(normalizeAddress('0xABCD')).toBe('0xabcd');
  });
  test('sanitizeHostHandle strips control + limits length', () => {
    expect(sanitizeHostHandle('hello\x00\x01world')).toBe('helloworld');
    expect(sanitizeHostHandle('x'.repeat(50)).length).toBe(32);
  });
});
