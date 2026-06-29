/**
 * F9 i18n foundation (ARCHITECTURE.md Section 20).
 *
 * Centralises user-facing strings in JSON tables keyed by dot path. Three
 * languages ship in this PR: `en` (default), `it` (Italian — narrative-critical
 * per CURVA_TECHNICAL_SPEC Section 15), `id` (Indonesian — Curva Nord Jakarta
 * demo room).
 *
 * Lookup semantics:
 *   - Dot-path key: `t('errors.NOT_FOUND', 'it')`.
 *   - Fall back to `en` if missing in the requested lang.
 *   - Return the key itself if missing in both (never throw, never crash).
 *   - ICU-style `{name}` interpolation only — no plural/select.
 *
 * Detection priority (resolveLang): `?lang=` query > Accept-Language header > en.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Lang = 'en' | 'it' | 'id';
export const SUPPORTED_LANGS: readonly Lang[] = ['en', 'it', 'id'] as const;

export const isSupportedLang = (value: unknown): value is Lang =>
  value === 'en' || value === 'it' || value === 'id';

// `main-config.ts` reads the env-overridable default and validates it; we
// re-derive the same default here without importing main-config to keep i18n
// usable from any layer (including main-config itself, in theory). A typo in
// DEFAULT_LANG silently falls back to 'en'.
const _envDefault = (process.env.DEFAULT_LANG || '').toLowerCase();
export const DEFAULT_LANG: Lang = isSupportedLang(_envDefault) ? _envDefault : 'en';

// =============================================================================
// Translation table load — once, frozen.
// =============================================================================

type TranslationTable = Record<string, unknown>;

const TABLES: Record<Lang, TranslationTable> = {
  en: {},
  it: {},
  id: {},
};

const loadTable = (lang: Lang): TranslationTable => {
  const path = resolve(process.cwd(), 'src/data/translations', `${lang}.json`);
  try {
    const txt = readFileSync(path, 'utf8');
    const parsed = JSON.parse(txt) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[i18n] ${lang}.json is not a JSON object; using empty table`);
      return {};
    }
    return parsed as TranslationTable;
  } catch (err) {
    console.warn(
      `[i18n] failed to load ${lang}.json:`,
      (err as Error)?.message ?? String(err)
    );
    return {};
  }
};

// Eager load at module init. Any future hot-reload would re-import the module.
for (const lang of SUPPORTED_LANGS) {
  TABLES[lang] = Object.freeze(loadTable(lang));
}

// =============================================================================
// Dot-path lookup
// =============================================================================

const lookup = (table: TranslationTable, key: string): string | undefined => {
  if (!key) return undefined;
  const segments = key.split('.');
  let cur: unknown = table;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === 'string' ? cur : undefined;
};

const interpolate = (
  template: string,
  params?: Record<string, string | number>
): string => {
  if (!params) return template;
  // Replace `{name}` placeholders. Missing keys leave the placeholder intact so
  // missing-data bugs surface visibly rather than corrupting output silently.
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const v = params[name];
    if (v === undefined || v === null) return match;
    return String(v);
  });
};

/**
 * Translate a dot-path key in the requested language, with `{name}`
 * interpolation. Falls back to `en`, then to the key itself.
 */
export const t = (
  key: string,
  lang: Lang,
  params?: Record<string, string | number>
): string => {
  const primary = lookup(TABLES[lang], key);
  if (primary !== undefined) return interpolate(primary, params);
  if (lang !== DEFAULT_LANG) {
    const fallback = lookup(TABLES[DEFAULT_LANG], key);
    if (fallback !== undefined) return interpolate(fallback, params);
  }
  // Return key verbatim — caller can detect missing translation by comparing.
  return key;
};

// =============================================================================
// Accept-Language parsing
// =============================================================================

/**
 * Parse an `Accept-Language` header and return the first supported language
 * tag, considering q-values. Examples:
 *   'it-IT,it;q=0.9,en;q=0.8' -> 'it'
 *   'en-US,en;q=0.5'          -> 'en'
 *   'fr,de;q=0.7'             -> DEFAULT_LANG ('en')
 *   '*'                       -> DEFAULT_LANG
 *   undefined                 -> DEFAULT_LANG
 */
export const parseAcceptLanguage = (header: string | undefined): Lang => {
  if (!header || typeof header !== 'string') return DEFAULT_LANG;

  // Bound the input (SECURITY_AUDIT.md W3-MED-04). Node's default
  // maxHeaderSize is ~16KiB, but this parser runs in a global preHandler
  // BEFORE route-level rate limits — so any per-request CPU cost is paid
  // even by 429-eligible callers. Cap both the raw header length and the
  // number of parsed entries to constant-time work.
  const MAX_HEADER_LENGTH = 1024;
  const MAX_ENTRIES = 20;
  const truncated = header.length > MAX_HEADER_LENGTH ? header.slice(0, MAX_HEADER_LENGTH) : header;
  // split(',', MAX_ENTRIES + 1) gives us at most MAX_ENTRIES + 1 elements;
  // the trailing slice ensures we never exceed MAX_ENTRIES regardless of
  // engine implementation quirks for the limit argument.
  const rawParts = truncated.split(',', MAX_ENTRIES + 1).slice(0, MAX_ENTRIES);

  // Parse the header into [lang, q] entries; default q=1.0.
  const entries: Array<{ tag: string; q: number }> = [];
  for (const raw of rawParts) {
    const part = raw.trim();
    if (!part) continue;
    const [tagRaw, ...params] = part.split(';');
    const tag = (tagRaw ?? '').trim().toLowerCase();
    if (!tag) continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.split('=');
      if (k && k.trim().toLowerCase() === 'q' && v) {
        const parsed = Number(v.trim());
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    entries.push({ tag, q });
  }

  // Sort by q descending; stable enough for our needs.
  entries.sort((a, b) => b.q - a.q);

  for (const { tag, q } of entries) {
    if (q <= 0) continue;
    if (tag === '*') continue;
    // Match either exact ('it') or primary subtag ('it-IT' -> 'it').
    const primary = tag.split('-')[0] ?? tag;
    if (isSupportedLang(primary)) return primary;
  }

  return DEFAULT_LANG;
};

/**
 * Resolve the request language. Precedence: query > Accept-Language > default.
 */
export const resolveLang = (opts: {
  query?: unknown;
  acceptLanguage?: string | undefined;
}): Lang => {
  // Query param wins.
  if (typeof opts.query === 'string') {
    const q = opts.query.trim().toLowerCase();
    if (isSupportedLang(q)) return q;
  }
  return parseAcceptLanguage(opts.acceptLanguage);
};
