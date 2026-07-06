/**
 * F12 QVAC model registry loader.
 *
 * Reads `src/data/qvac-models.json` once at boot, applies optional per-model
 * env overrides (QVAC_MODEL_<ID_UPPER_SNAKE>_URL / _DIGEST / _STATUS), and
 * freezes the result. Any malformed input throws at boot so the failure is
 * caught before the process starts serving requests.
 *
 * Per ADR-012: the catalog changes at deploy cadence (JSON PR) or via env
 * override, never at runtime. Backend serves a snapshot.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type QvacModelFamily =
  | 'bergamot'
  | 'whisper'
  | 'llama'
  | 'parakeet'
  | 'silero-vad'
  | 'tts-supertonic';
export type QvacModelStatus = 'ready' | 'pending-upstream' | 'deprecated';

export interface QvacModel {
  id: string;
  name: string;
  family: QvacModelFamily;
  size: number;
  sizeLabel: string;
  capabilities: string[];
  sourceLangs: string[];
  targetLangs: string[];
  /** `sha256:<hex>` (lowercase) or null when integrity is not yet pinned. */
  contentDigest: string | null;
  downloadUrl: string;
  mirrorUrl: string | null;
  license: string;
  notes: string;
  status: QvacModelStatus;
}

export interface QvacRegistry {
  version: string;
  generatedAt: string;
  models: QvacModel[];
}

// -----------------------------------------------------------------------------
// Parsing helpers
// -----------------------------------------------------------------------------

const KNOWN_FAMILIES: ReadonlySet<QvacModelFamily> = new Set([
  'bergamot',
  'whisper',
  'llama',
  'parakeet',
  'silero-vad',
  'tts-supertonic',
]);
const KNOWN_STATUSES: ReadonlySet<QvacModelStatus> = new Set([
  'ready',
  'pending-upstream',
  'deprecated',
]);

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Convert 'bergamot-it-en' -> 'BERGAMOT_IT_EN' for env-key derivation. */
const envKeyFor = (id: string): string =>
  id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/**
 * Apply optional env overrides. Missing overrides leave the JSON value intact.
 * Callers pass `env` explicitly so tests can supply a fake without mutating
 * process.env.
 */
const applyOverrides = (
  m: QvacModel,
  env: NodeJS.ProcessEnv = process.env
): QvacModel => {
  const key = envKeyFor(m.id);
  const url = env[`QVAC_MODEL_${key}_URL`];
  const digest = env[`QVAC_MODEL_${key}_DIGEST`];
  const status = env[`QVAC_MODEL_${key}_STATUS`];
  const next: QvacModel = { ...m };
  if (url && url.trim()) next.downloadUrl = url.trim();
  if (digest && digest.trim()) next.contentDigest = digest.trim().toLowerCase();
  if (status && KNOWN_STATUSES.has(status as QvacModelStatus)) {
    next.status = status as QvacModelStatus;
  }
  return next;
};

/** Validate & normalise a single JSON entry. Throws on any structural fault. */
const parseModel = (raw: unknown, index: number): QvacModel => {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`qvac-models.json[${index}]: entry is not an object`);
  }
  const r = raw as Record<string, unknown>;
  if (!isString(r.id) || !r.id) throw new Error(`qvac-models.json[${index}]: id missing`);
  if (!isString(r.name)) throw new Error(`qvac-models.json[${index}]: name missing`);
  if (!isString(r.family) || !KNOWN_FAMILIES.has(r.family as QvacModelFamily)) {
    throw new Error(`qvac-models.json[${index}]: family invalid`);
  }
  if (typeof r.size !== 'number' || !Number.isFinite(r.size) || r.size < 0) {
    throw new Error(`qvac-models.json[${index}]: size must be a non-negative number`);
  }
  if (!isString(r.sizeLabel)) throw new Error(`qvac-models.json[${index}]: sizeLabel missing`);
  if (!isStringArr(r.capabilities)) {
    throw new Error(`qvac-models.json[${index}]: capabilities must be string[]`);
  }
  if (!isStringArr(r.sourceLangs)) {
    throw new Error(`qvac-models.json[${index}]: sourceLangs must be string[]`);
  }
  if (!isStringArr(r.targetLangs)) {
    throw new Error(`qvac-models.json[${index}]: targetLangs must be string[]`);
  }
  if (r.contentDigest !== null && !isString(r.contentDigest)) {
    throw new Error(`qvac-models.json[${index}]: contentDigest must be string or null`);
  }
  if (!isString(r.downloadUrl)) {
    throw new Error(`qvac-models.json[${index}]: downloadUrl missing`);
  }
  if (r.mirrorUrl !== null && !isString(r.mirrorUrl)) {
    throw new Error(`qvac-models.json[${index}]: mirrorUrl must be string or null`);
  }
  if (!isString(r.license)) throw new Error(`qvac-models.json[${index}]: license missing`);
  if (!isString(r.notes)) throw new Error(`qvac-models.json[${index}]: notes missing`);
  if (!isString(r.status) || !KNOWN_STATUSES.has(r.status as QvacModelStatus)) {
    throw new Error(`qvac-models.json[${index}]: status invalid`);
  }
  return {
    id: r.id,
    name: r.name,
    family: r.family as QvacModelFamily,
    size: r.size,
    sizeLabel: r.sizeLabel,
    capabilities: [...r.capabilities],
    sourceLangs: [...r.sourceLangs],
    targetLangs: [...r.targetLangs],
    contentDigest: r.contentDigest ? (r.contentDigest as string).toLowerCase() : null,
    downloadUrl: r.downloadUrl,
    mirrorUrl: r.mirrorUrl as string | null,
    license: r.license,
    notes: r.notes,
    status: r.status as QvacModelStatus,
  };
};

const parseRegistry = (raw: unknown): QvacRegistry => {
  if (!raw || typeof raw !== 'object') {
    throw new Error('qvac-models.json: root must be an object');
  }
  const r = raw as Record<string, unknown>;
  if (!isString(r.version)) throw new Error('qvac-models.json: version missing');
  if (!isString(r.generatedAt)) throw new Error('qvac-models.json: generatedAt missing');
  if (!Array.isArray(r.models)) throw new Error('qvac-models.json: models must be an array');
  const models = r.models.map((m, i) => parseModel(m, i));
  // Unique-id invariant. Duplicates would let one entry silently shadow another.
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.id)) throw new Error(`qvac-models.json: duplicate model id "${m.id}"`);
    seen.add(m.id);
  }
  return { version: r.version, generatedAt: r.generatedAt, models };
};

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

const DATA_PATH = resolve(process.cwd(), 'src/data/qvac-models.json');

let cached: Readonly<QvacRegistry> | null = null;

/**
 * Load, validate, apply env overrides, and freeze. Cached after first call.
 * Throws at boot if the JSON is malformed.
 */
export const loadRegistry = (): Readonly<QvacRegistry> => {
  if (cached) return cached;
  const txt = readFileSync(DATA_PATH, 'utf8');
  const parsed = parseRegistry(JSON.parse(txt));
  const withOverrides = parsed.models.map((m) => applyOverrides(m));
  cached = Object.freeze({
    version: parsed.version,
    generatedAt: parsed.generatedAt,
    models: Object.freeze(withOverrides.map((m) => Object.freeze(m))) as QvacModel[],
  }) as Readonly<QvacRegistry>;
  return cached;
};

export const getModel = (id: string): QvacModel | undefined => {
  if (!id || typeof id !== 'string') return undefined;
  return loadRegistry().models.find((m) => m.id === id);
};

export interface QvacRegistryFilter {
  family?: string;
  capability?: string;
}

export const listModels = (filter?: QvacRegistryFilter): QvacModel[] => {
  const all = loadRegistry().models;
  if (!filter) return [...all];
  return all.filter((m) => {
    if (filter.family && m.family !== filter.family) return false;
    if (filter.capability && !m.capabilities.includes(filter.capability)) return false;
    return true;
  });
};

/**
 * Test-only: clear the memoised registry so a subsequent loadRegistry() re-reads
 * the file (needed if a test mutates the JSON on disk).
 */
export const __resetForTest = (): void => {
  cached = null;
};
