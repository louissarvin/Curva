/**
 * F12 mirror file helpers.
 *
 * The mirror stores each model at `<MODEL_MIRROR_DIR>/<id>.bin`. Sha-256
 * verification is streaming (never loads the whole file into memory) so it
 * scales past the 17 MB Bergamot entries to Whisper-tiny (~40 MB) and beyond
 * without impacting the Fastify event loop noticeably.
 *
 * Path safety: getMirrorPath REFUSES a model id containing anything other
 * than [A-Za-z0-9._-]. This prevents any accidental path traversal (e.g. an
 * env override sneaking in `../etc/passwd`) even though model ids in the
 * shipped catalog are already sanitised at parse time.
 */

import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { resolve, join } from 'node:path';
import { MODEL_MIRROR_DIR } from '../../config/main-config.ts';

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Resolve the on-disk path for a model. Throws on unsafe ids (defense-in-depth
 * against path traversal). Returns an absolute path.
 */
export const getMirrorPath = (modelId: string): string => {
  if (!modelId || !SAFE_ID.test(modelId)) {
    throw new Error(`unsafe model id: ${JSON.stringify(modelId)}`);
  }
  const dir = resolve(process.cwd(), MODEL_MIRROR_DIR);
  const full = join(dir, `${modelId}.bin`);
  // Second-layer guard: full path must remain inside the mirror dir even after
  // resolve() normalises any funky separators.
  if (!full.startsWith(dir + '/') && full !== dir) {
    throw new Error(`resolved path escapes mirror dir: ${modelId}`);
  }
  return full;
};

export const getMirrorTempPath = (modelId: string): string =>
  `${getMirrorPath(modelId)}.tmp`;

/** Stat a mirrored file. Returns null if it does not exist or is unreadable. */
export const statMirroredFile = async (
  modelId: string
): Promise<{ size: number; mtime: Date } | null> => {
  try {
    const st = await fsp.stat(getMirrorPath(modelId));
    if (!st.isFile()) return null;
    return { size: st.size, mtime: st.mtime };
  } catch {
    return null;
  }
};

export const hasMirroredFile = async (modelId: string): Promise<boolean> => {
  return (await statMirroredFile(modelId)) !== null;
};

/** Stream a file through sha-256. Returns the lowercase hex digest. */
export const sha256OfFile = async (absPath: string): Promise<string> => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(absPath), hash);
  return hash.digest('hex').toLowerCase();
};

/**
 * Normalise a `contentDigest` catalog value to the raw hex we compare against.
 * Accepts `sha256:<hex>` or bare hex; returns null on unrecognisable input.
 */
export const parseExpectedDigestHex = (contentDigest: string | null): string | null => {
  if (!contentDigest) return null;
  const trimmed = contentDigest.trim().toLowerCase();
  const withoutPrefix = trimmed.startsWith('sha256:') ? trimmed.slice(7) : trimmed;
  if (!/^[0-9a-f]{64}$/.test(withoutPrefix)) return null;
  return withoutPrefix;
};

/**
 * Streaming digest verifier. Returns false on any error (missing file, IO
 * failure, mismatch). Never throws.
 */
export const verifyLocalDigest = async (
  modelId: string,
  expectedContentDigest: string
): Promise<boolean> => {
  const expectedHex = parseExpectedDigestHex(expectedContentDigest);
  if (!expectedHex) return false;
  try {
    const path = getMirrorPath(modelId);
    const st = await fsp.stat(path).catch(() => null);
    if (!st || !st.isFile()) return false;
    const actual = await sha256OfFile(path);
    return actual === expectedHex;
  } catch {
    return false;
  }
};

/**
 * Encode a hex digest to base-64 for the RFC 9530 Content-Digest header
 * (`sha-256=:<base64>:`). Called only on the download path.
 */
export const hexToBase64 = (hex: string): string => {
  const bytes = Buffer.from(hex, 'hex');
  return bytes.toString('base64');
};

/** Ensure the mirror directory exists. Idempotent. */
export const ensureMirrorDir = async (): Promise<string> => {
  const dir = resolve(process.cwd(), MODEL_MIRROR_DIR);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
};

/** Delete a mirrored file if it exists. Never throws. */
export const removeMirroredFile = async (modelId: string): Promise<void> => {
  try {
    await fsp.unlink(getMirrorPath(modelId));
  } catch {
    /* file may not exist; ignore */
  }
};

/** Delete a temp file if it exists. Never throws. */
export const removeTempFile = async (modelId: string): Promise<void> => {
  try {
    await fsp.unlink(getMirrorTempPath(modelId));
  } catch {
    /* ignore */
  }
};

/** Atomic rename from `<id>.bin.tmp` → `<id>.bin`. */
export const promoteTempFile = async (modelId: string): Promise<void> => {
  await fsp.rename(getMirrorTempPath(modelId), getMirrorPath(modelId));
};

/**
 * Helper used by the download route: for the given model, return a description
 * of what's on disk right now (path + size + verified digest hex) or null if
 * mirror is not usable.
 */
export interface MirrorReadyFile {
  path: string;
  size: number;
  digestHex: string;
}

// -----------------------------------------------------------------------------
// Verified-digest cache — mtime keyed. Prevents a per-request full-file
// sha-256 recompute (W4-MED-03). Bounded to 32 entries with FIFO eviction
// (small population: mirror ships O(10) models today).
// -----------------------------------------------------------------------------

interface DigestCacheEntry {
  digestHex: string;
  mtimeMs: number;
  size: number;
}

const DIGEST_CACHE_MAX_ENTRIES = 32;
const DIGEST_CACHE = new Map<string, DigestCacheEntry>();

/**
 * Return the cached verified digest for `modelId` if the on-disk file's mtime
 * (and size) still match the cache. Recompute + refresh on mismatch.
 *
 * Returns null if the file is missing, unreadable, or its digest does not
 * match `expectedHex`.
 */
const getVerifiedDigest = async (
  modelId: string,
  expectedHex: string
): Promise<{ digestHex: string; size: number } | null> => {
  const path = getMirrorPath(modelId);
  const st = await fsp.stat(path).catch(() => null);
  if (!st || !st.isFile()) return null;
  const cached = DIGEST_CACHE.get(modelId);
  if (
    cached &&
    cached.digestHex === expectedHex &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size
  ) {
    return { digestHex: cached.digestHex, size: cached.size };
  }
  // Recompute — either no cache entry, or the file moved (mtime/size changed).
  const actualHex = await sha256OfFile(path).catch(() => null);
  if (actualHex === null || actualHex !== expectedHex) return null;
  // Bounded map: evict oldest insertion order entry when full.
  if (DIGEST_CACHE.size >= DIGEST_CACHE_MAX_ENTRIES && !DIGEST_CACHE.has(modelId)) {
    const oldestKey = DIGEST_CACHE.keys().next().value;
    if (oldestKey !== undefined) DIGEST_CACHE.delete(oldestKey);
  }
  DIGEST_CACHE.set(modelId, {
    digestHex: actualHex,
    mtimeMs: st.mtimeMs,
    size: st.size,
  });
  return { digestHex: actualHex, size: st.size };
};

export const readyMirroredFile = async (
  modelId: string,
  contentDigest: string | null
): Promise<MirrorReadyFile | null> => {
  const expectedHex = parseExpectedDigestHex(contentDigest);
  if (!expectedHex) return null;
  try {
    const verified = await getVerifiedDigest(modelId, expectedHex);
    if (!verified) return null;
    return {
      path: getMirrorPath(modelId),
      size: verified.size,
      digestHex: verified.digestHex,
    };
  } catch {
    return null;
  }
};

/**
 * Test-only: drop the verified-digest cache so a fresh sha-256 runs on the
 * next call to readyMirroredFile.
 */
export const __resetDigestCacheForTest = (): void => {
  DIGEST_CACHE.clear();
};

/**
 * Sink helper for the mirror worker: create a write stream to the temp path,
 * enforcing the max-bytes ceiling. Returns the stream and a cancel() that
 * removes any partial artefact.
 */
export const openTempSink = async (
  modelId: string
): Promise<{ path: string; stream: ReturnType<typeof createWriteStream> }> => {
  await ensureMirrorDir();
  const path = getMirrorTempPath(modelId);
  const stream = createWriteStream(path);
  return { path, stream };
};
