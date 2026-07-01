/**
 * F12 mirror helper tests.
 *
 * We write a small file to a temp mirror dir, ask the helper to verify against
 * the true digest, and against a fake digest to confirm mismatch handling.
 */

import { describe, expect, test, beforeAll, afterAll, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, promises as fsp, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fresh temp dir for this suite. We mock main-config so MODEL_MIRROR_DIR
// resolves here regardless of which test file loaded main-config first.
const TMP_DIR = mkdtempSync(join(tmpdir(), 'curva-qvac-mirror-'));

const realConfig = await import('../../../src/config/main-config.ts');
mock.module('../../../src/config/main-config.ts', () => ({
  ...realConfig,
  MODEL_MIRROR_DIR: TMP_DIR,
}));

const {
  getMirrorPath,
  hasMirroredFile,
  verifyLocalDigest,
  parseExpectedDigestHex,
  hexToBase64,
  readyMirroredFile,
} = await import('../../../src/lib/qvac/mirror.ts');

const MODEL_ID = 'test-model';
const PAYLOAD = Buffer.from('curva-mirror-test-payload-2026-07-01', 'utf8');
const EXPECTED_HEX = createHash('sha256').update(PAYLOAD).digest('hex');

beforeAll(() => {
  // TMP_DIR was created via mkdtempSync — nothing more to do.
  const p = getMirrorPath(MODEL_ID);
  writeFileSync(p, PAYLOAD);
});

afterAll(async () => {
  await fsp.rm(TMP_DIR, { recursive: true, force: true }).catch(() => undefined);
});

describe('QVAC mirror helpers', () => {
  test('hasMirroredFile returns true for existing file', async () => {
    expect(await hasMirroredFile(MODEL_ID)).toBe(true);
  });

  test('hasMirroredFile returns false for missing file', async () => {
    expect(await hasMirroredFile('nonexistent')).toBe(false);
  });

  test('verifyLocalDigest returns true on matching digest', async () => {
    expect(await verifyLocalDigest(MODEL_ID, `sha256:${EXPECTED_HEX}`)).toBe(true);
    expect(await verifyLocalDigest(MODEL_ID, EXPECTED_HEX)).toBe(true);
  });

  test('verifyLocalDigest returns false on mismatch', async () => {
    const wrong = 'a'.repeat(64);
    expect(await verifyLocalDigest(MODEL_ID, wrong)).toBe(false);
  });

  test('verifyLocalDigest returns false when file missing', async () => {
    expect(await verifyLocalDigest('missing', EXPECTED_HEX)).toBe(false);
  });

  test('verifyLocalDigest returns false on malformed digest', async () => {
    expect(await verifyLocalDigest(MODEL_ID, '')).toBe(false);
    expect(await verifyLocalDigest(MODEL_ID, 'not-hex')).toBe(false);
    expect(await verifyLocalDigest(MODEL_ID, 'sha256:short')).toBe(false);
  });

  test('parseExpectedDigestHex accepts prefixed and bare hex', () => {
    expect(parseExpectedDigestHex(`sha256:${EXPECTED_HEX}`)).toBe(EXPECTED_HEX);
    expect(parseExpectedDigestHex(EXPECTED_HEX)).toBe(EXPECTED_HEX);
    expect(parseExpectedDigestHex('sha256:' + EXPECTED_HEX.toUpperCase())).toBe(
      EXPECTED_HEX
    );
  });

  test('parseExpectedDigestHex rejects garbage', () => {
    expect(parseExpectedDigestHex(null)).toBeNull();
    expect(parseExpectedDigestHex('')).toBeNull();
    expect(parseExpectedDigestHex('nope')).toBeNull();
    expect(parseExpectedDigestHex('sha256:xyz')).toBeNull();
  });

  test('hexToBase64 produces valid base64 of expected length', () => {
    const b64 = hexToBase64(EXPECTED_HEX);
    expect(b64.length).toBeGreaterThan(40);
    // 32-byte digest → 44-char base64 (with padding).
    expect(Buffer.from(b64, 'base64').toString('hex')).toBe(EXPECTED_HEX);
  });

  test('getMirrorPath rejects path traversal', () => {
    expect(() => getMirrorPath('../evil')).toThrow();
    expect(() => getMirrorPath('foo/bar')).toThrow();
    expect(() => getMirrorPath('')).toThrow();
  });

  test('readyMirroredFile returns file info on match', async () => {
    const ready = await readyMirroredFile(MODEL_ID, `sha256:${EXPECTED_HEX}`);
    expect(ready).not.toBeNull();
    expect(ready?.size).toBe(PAYLOAD.length);
    expect(ready?.digestHex).toBe(EXPECTED_HEX);
  });

  test('readyMirroredFile returns null on mismatch', async () => {
    expect(await readyMirroredFile(MODEL_ID, 'a'.repeat(64))).toBeNull();
    expect(await readyMirroredFile(MODEL_ID, null)).toBeNull();
    expect(await readyMirroredFile('missing', EXPECTED_HEX)).toBeNull();
  });
});
