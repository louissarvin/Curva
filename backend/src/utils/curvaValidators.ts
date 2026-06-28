/**
 * Curva-specific field-shape validators.
 * Pure regex / length checks; no Zod or runtime schema lib needed.
 */

import { ethers } from 'ethers';

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{2,30})[a-z0-9]$/;
// Reserved slug prefix owned by the matchAutoWarmWorker (ARCHITECTURE.md F2).
// User-supplied slugs starting with this string are rejected at POST /rooms to
// prevent slug-squatting against the deterministic auto-<matchId> namespace.
// See SECURITY_AUDIT.md W2-HIGH-01.
export const RESERVED_SLUG_PREFIXES: ReadonlyArray<string> = ['auto-'];

export const slugHasReservedPrefix = (s: string): boolean =>
  RESERVED_SLUG_PREFIXES.some((p) => s.startsWith(p));
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HOST_HANDLE_CTRL_RE = /[\x00-\x1f]/;
const PEAR_LINK_RE = /^pear:\/\/[A-Za-z0-9._~:\/?#\[\]@!$&'()*+,;=%-]{1,193}$/;
const ISO3_TEAM_CODE_RE = /^[A-Z]{3}$/;
const MATCH_STAGES = new Set(['group', 'r16', 'qf', 'sf', 'third_place', 'final']);
const MATCH_STATUSES = new Set(['scheduled', 'live', 'finished', 'postponed', 'cancelled']);

export const isValidSlug = (s: unknown): s is string =>
  typeof s === 'string' && s.length >= 4 && s.length <= 32 && SLUG_RE.test(s);

export const isValidEvmAddress = (s: unknown): s is string => {
  if (typeof s !== 'string') return false;
  if (!EVM_ADDRESS_RE.test(s)) return false;
  try {
    // ethers.isAddress accepts checksum AND non-checksum
    return ethers.isAddress(s);
  } catch {
    return false;
  }
};

export const isValidHostHandle = (s: unknown): s is string =>
  typeof s === 'string' && s.length >= 1 && s.length <= 32 && !HOST_HANDLE_CTRL_RE.test(s);

export const isValidPearLink = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 200 && PEAR_LINK_RE.test(s);

export const isValidTeamCode = (s: unknown): s is string =>
  typeof s === 'string' && ISO3_TEAM_CODE_RE.test(s);

export const isValidMatchStage = (s: unknown): s is string =>
  typeof s === 'string' && MATCH_STAGES.has(s);

export const isValidMatchStatus = (s: unknown): s is string =>
  typeof s === 'string' && MATCH_STATUSES.has(s);

export const isValidCuid = (s: unknown): s is string =>
  typeof s === 'string' && /^c[a-z0-9]{20,32}$/.test(s);

export const isValidIso8601 = (s: unknown): s is string => {
  if (typeof s !== 'string') return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
};

/**
 * Parse a positive integer with bounds. Returns the parsed number or null if invalid.
 * Used for limit/offset query params where we accept strings from URL.
 */
export const parseBoundedInt = (
  raw: unknown,
  min: number,
  max: number,
  fallback: number
): number => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
};

/**
 * Normalize a slug: lowercase + trim.
 */
export const normalizeSlug = (s: string): string => s.toLowerCase().trim();

/**
 * Normalize an EVM address: lowercase (no checksum) for stable indexing.
 */
export const normalizeAddress = (s: string): string => s.toLowerCase().trim();

/**
 * Strip control chars from host handles.
 */
export const sanitizeHostHandle = (s: string): string =>
  s.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 32);

export const MATCH_STAGE_VALUES = Array.from(MATCH_STAGES);
export const MATCH_STATUS_VALUES = Array.from(MATCH_STATUSES);
