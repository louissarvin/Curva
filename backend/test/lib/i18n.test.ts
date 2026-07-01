/**
 * F9 unit tests for the i18n helper.
 *
 * Covers dot-path lookup, fallback chain, ICU `{name}` interpolation,
 * Accept-Language q-value parsing, and resolveLang precedence.
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LANG,
  SUPPORTED_LANGS,
  isSupportedLang,
  parseAcceptLanguage,
  resolveLang,
  t,
} from '../../src/lib/i18n/index.ts';

describe('i18n module surface', () => {
  test('exposes the three supported languages with en as default', () => {
    expect([...SUPPORTED_LANGS].sort()).toEqual(['en', 'id', 'it']);
    expect(DEFAULT_LANG).toBe('en');
  });

  test('isSupportedLang accepts en/it/id and rejects anything else', () => {
    expect(isSupportedLang('en')).toBe(true);
    expect(isSupportedLang('it')).toBe(true);
    expect(isSupportedLang('id')).toBe(true);
    expect(isSupportedLang('fr')).toBe(false);
    expect(isSupportedLang('EN')).toBe(false); // case-sensitive on purpose
    expect(isSupportedLang(undefined)).toBe(false);
    expect(isSupportedLang(null)).toBe(false);
    expect(isSupportedLang(42)).toBe(false);
  });
});

describe('t() — dot-path lookup', () => {
  test('finds shallow keys in the requested language', () => {
    expect(t('common.ok', 'en')).toBe('ok');
    expect(t('common.degraded', 'it')).toBe('degradato');
    expect(t('common.down', 'id')).toBe('mati');
  });

  test('finds deep keys (errors, matches.status)', () => {
    expect(t('errors.NOT_FOUND', 'en')).toBe('Not found');
    expect(t('errors.NOT_FOUND', 'it')).toBe('Non trovato');
    expect(t('matches.status.in_progress', 'it')).toBe('Dal vivo');
    expect(t('matches.status.halftime', 'id')).toBe('Turun minum');
  });

  test('falls back to en when a key is missing in the requested lang', () => {
    // `phrases.tweet_quote` exists only in it.json; en.json doesn't have it,
    // so requesting it in `id` should fall back to en, which also lacks it,
    // and finally return the key itself. We instead pick a key that exists in
    // en but is omitted in id to test the fallback chain.
    // `tips.received` exists in all three; pick a real divergence: in it.json,
    // `phrases.demo_close` exists; en.json doesn't. Requesting en should
    // return the key (no en, no fallback below en).
    expect(t('phrases.demo_close', 'en')).toBe('phrases.demo_close');
    // Requesting `id` should fall back to en, which also lacks it -> key.
    expect(t('phrases.demo_close', 'id')).toBe('phrases.demo_close');
    // Requesting `it` returns the Italian string directly.
    expect(t('phrases.demo_close', 'it')).toBe('Cosi il calcio doveva essere.');
  });

  test('returns the key itself when missing in both lang and en', () => {
    expect(t('this.key.absolutely.does.not.exist', 'en')).toBe('this.key.absolutely.does.not.exist');
    expect(t('this.key.absolutely.does.not.exist', 'it')).toBe('this.key.absolutely.does.not.exist');
    expect(t('this.key.absolutely.does.not.exist', 'id')).toBe('this.key.absolutely.does.not.exist');
  });

  test('returns the key when the path lands on a non-string node (e.g. an object)', () => {
    // `matches.status` is an object, not a leaf string.
    expect(t('matches.status', 'en')).toBe('matches.status');
  });
});

describe('t() — ICU {name} interpolation', () => {
  test('substitutes a present param', () => {
    expect(t('errors.MISSING_FIELDS', 'en', { field: 'slug' })).toBe(
      'Missing required field: slug'
    );
    expect(t('errors.MISSING_FIELDS', 'it', { field: 'slug' })).toBe(
      'Campo obbligatorio mancante: slug'
    );
  });

  test('leaves the placeholder intact when the param is missing', () => {
    expect(t('errors.MISSING_FIELDS', 'en')).toBe('Missing required field: {field}');
    expect(t('errors.MISSING_FIELDS', 'en', { other: 'x' })).toBe(
      'Missing required field: {field}'
    );
  });

  test('coerces numeric params to strings', () => {
    expect(t('matches.label.kickoff_in', 'en', { minutes: 5 })).toBe('Kicks off in 5 min');
    expect(t('rooms.expires_in', 'it', { hours: 24 })).toBe('Scade fra 24h');
  });
});

describe('parseAcceptLanguage()', () => {
  test('returns DEFAULT_LANG for undefined / empty', () => {
    expect(parseAcceptLanguage(undefined)).toBe('en');
    expect(parseAcceptLanguage('')).toBe('en');
  });

  test('matches primary subtag (it-IT -> it)', () => {
    expect(parseAcceptLanguage('it-IT')).toBe('it');
    expect(parseAcceptLanguage('id-ID')).toBe('id');
    expect(parseAcceptLanguage('en-US')).toBe('en');
  });

  test('respects q-value precedence', () => {
    expect(parseAcceptLanguage('it-IT,it;q=0.9,en;q=0.8')).toBe('it');
    expect(parseAcceptLanguage('en;q=0.5,it;q=0.9')).toBe('it');
    expect(parseAcceptLanguage('fr;q=1.0,it;q=0.7,en;q=0.3')).toBe('it');
  });

  test('skips q=0 entries', () => {
    expect(parseAcceptLanguage('it;q=0,en;q=0.5')).toBe('en');
  });

  test('falls back to default for unknown languages only', () => {
    expect(parseAcceptLanguage('fr-FR,de;q=0.9')).toBe('en');
    expect(parseAcceptLanguage('zh-CN')).toBe('en');
  });

  test('handles wildcard gracefully', () => {
    expect(parseAcceptLanguage('*')).toBe('en');
    expect(parseAcceptLanguage('*;q=0.5')).toBe('en');
  });

  // W3-MED-04: defensive bounds against header-amplification CPU attacks.
  test('caps massive headers to MAX_ENTRIES without timing out', () => {
    // 10,000 trailing commas would produce ~10,000 entries; capped at 20.
    const evil = 'a,'.repeat(10_000);
    const start = Date.now();
    const result = parseAcceptLanguage(evil);
    const elapsed = Date.now() - start;
    expect(result).toBe('en');
    // Bound is generous (~100ms) so CI variance does not flake this; the real
    // assertion is "no OOM, no event-loop stall".
    expect(elapsed).toBeLessThan(100);
  });

  test('regression: it-IT,en;q=0.9 still resolves to it after bounds added', () => {
    expect(parseAcceptLanguage('it-IT,en;q=0.9')).toBe('it');
  });
});

describe('resolveLang() — precedence', () => {
  test('query param wins over Accept-Language', () => {
    expect(
      resolveLang({ query: 'it', acceptLanguage: 'en-US,en;q=0.9' })
    ).toBe('it');
    expect(
      resolveLang({ query: 'id', acceptLanguage: 'it-IT' })
    ).toBe('id');
  });

  test('falls through to Accept-Language when query is missing or unsupported', () => {
    expect(resolveLang({ acceptLanguage: 'it-IT' })).toBe('it');
    expect(resolveLang({ query: undefined, acceptLanguage: 'id' })).toBe('id');
    expect(resolveLang({ query: 'fr', acceptLanguage: 'it-IT' })).toBe('it');
  });

  test('returns DEFAULT_LANG when neither resolves to a supported tag', () => {
    expect(resolveLang({})).toBe('en');
    expect(resolveLang({ query: 'fr', acceptLanguage: 'de' })).toBe('en');
  });

  test('ignores non-string query values', () => {
    expect(resolveLang({ query: ['it'], acceptLanguage: 'id' })).toBe('id');
    expect(resolveLang({ query: 42, acceptLanguage: 'it' })).toBe('it');
  });
});
