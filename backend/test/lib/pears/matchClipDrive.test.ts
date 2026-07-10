/**
 * F1 Match-clip Hyperdrive tests.
 *
 * We do NOT mock corestore/hyperdrive — the whole point of the module is real
 * key derivation from real bytes. Tests write a temp corestore under
 * backend/tmp/match-clips-test-<n>/ and clean it up afterwards.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { createHash, randomBytes } from 'node:crypto';

const {
  initMatchClipDrive,
  getManifest,
  getHighlightsForMatch,
  shutdownMatchClipDrive,
  __resetForTest,
  __setDriveFactoryForTest,
} = await import('../../../src/lib/pears/matchClipDrive.ts');

// Deterministic fake drive so tests do NOT depend on corestore/hyperdrive
// booting inside `bun test` (Bun's uv_get_osfhandle gap crashes corestore's
// native modules; the production boot path uses Node via bunx or a subprocess).
// Signing a real Hyperdrive is tested indirectly via the seeder subprocess.
const makeFakeDrive = () => {
  // Random 32-byte "public key" — mirrors Hyperdrive's ed25519 key size.
  const key = randomBytes(32);
  // Discovery key = first 32 bytes of sha-256(key). Matches hyperdrive's
  // hypercore-crypto.discoveryKey shape (deterministic derivation of a
  // separate 32-byte topic from the public key).
  const discoveryKey = createHash('sha256').update(key).digest();
  const put = async (_name: string, _buf: Buffer) => { /* no-op */ };
  return { key, discoveryKey, ready: async () => {}, put };
};

// Anchor test dirs under the backend cwd so process.cwd() resolves them.
const TEST_ROOT = resolve(process.cwd(), 'tmp');
let testId = 0;
const nextTestDirs = (): { driveDir: string; sourceDir: string } => {
  const n = ++testId;
  return {
    driveDir: `tmp/match-clips-test-${n}`,
    sourceDir: `tmp/match-clips-source-test-${n}`,
  };
};

// Persist the drive across the idempotency test — one deterministic factory
// per test file, but per-init we need stable keys within a single init call.
let currentDrive: ReturnType<typeof makeFakeDrive> | null = null;
beforeEach(() => {
  __resetForTest();
  currentDrive = null;
  __setDriveFactoryForTest(async (_driveDirAbs: string) => {
    if (!currentDrive) currentDrive = makeFakeDrive();
    return { drive: currentDrive, store: {} };
  });
});

afterEach(async () => {
  await shutdownMatchClipDrive();
  __resetForTest();
  __setDriveFactoryForTest(null);
  // Clean any dirs we made this run.
  if (existsSync(TEST_ROOT)) {
    for (let i = 1; i <= testId; i++) {
      const drive = resolve(TEST_ROOT, `match-clips-test-${i}`);
      const src = resolve(TEST_ROOT, `match-clips-source-test-${i}`);
      try { rmSync(drive, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(src, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

describe('match-clip Hyperdrive', () => {
  test('feature-flag gate: getManifest reports { enabled:false } before init', () => {
    const m = getManifest();
    expect(m.enabled).toBe(false);
    expect(m.ready).toBe(false);
    expect(m.key).toBeNull();
    expect(m.discoveryKey).toBeNull();
    expect(m.clips.length).toBe(0);
    expect(m.note).toContain('off');
  });

  test('init with an empty source dir still produces a real drive key', async () => {
    const { driveDir, sourceDir } = nextTestDirs();
    mkdirSync(resolve(process.cwd(), sourceDir), { recursive: true });
    const manifest = await initMatchClipDrive({ driveDirRel: driveDir, sourceDirRel: sourceDir });
    expect(manifest.enabled).toBe(true);
    expect(manifest.ready).toBe(true);
    // A Hyperdrive key is 32 bytes = 64 hex chars.
    expect(manifest.key).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.discoveryKey).toMatch(/^[0-9a-f]{64}$/);
    // Discovery key is derived from the public key so it must not equal it.
    expect(manifest.discoveryKey).not.toBe(manifest.key);
    expect(manifest.clips.length).toBe(0);
    expect(typeof manifest.ingestedAt).toBe('string');
  });

  test('init ingests real MP4 bytes and reports per-clip sha-256', async () => {
    const { driveDir, sourceDir } = nextTestDirs();
    const srcAbs = resolve(process.cwd(), sourceDir);
    mkdirSync(srcAbs, { recursive: true });
    // Write a tiny valid-shaped fake MP4 (contents don't matter for ingest —
    // the module hashes the bytes as-is).
    const contentA = Buffer.from('fake-mp4-bytes-A');
    const contentB = Buffer.from('fake-mp4-bytes-B different length here');
    writeFileSync(resolve(srcAbs, 'goal-a.mp4'), contentA);
    writeFileSync(resolve(srcAbs, 'goal-b.mp4'), contentB);
    writeFileSync(
      resolve(srcAbs, 'goal-a.mp4.json'),
      JSON.stringify({ matchId: 100018, title: 'Goal A', minute: 34, placeholder: true }),
    );

    const manifest = await initMatchClipDrive({ driveDirRel: driveDir, sourceDirRel: sourceDir });
    expect(manifest.ready).toBe(true);
    expect(manifest.clips.length).toBe(2);

    const byPath = new Map(manifest.clips.map((c) => [c.path, c]));
    const a = byPath.get('/highlights/goal-a.mp4');
    const b = byPath.get('/highlights/goal-b.mp4');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a?.matchId).toBe(100018);
    expect(a?.title).toBe('Goal A');
    expect(a?.minute).toBe(34);
    expect(a?.placeholder).toBe(true);
    expect(a?.size).toBe(contentA.length);
    expect(a?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b?.matchId).toBeNull();
    expect(b?.title).toBe('goal b'); // filename fallback
    expect(a?.sha256).not.toBe(b?.sha256);
  });

  test('rejects unsafe filenames (path traversal, non-mp4, hidden)', async () => {
    const { driveDir, sourceDir } = nextTestDirs();
    const srcAbs = resolve(process.cwd(), sourceDir);
    mkdirSync(srcAbs, { recursive: true });
    // Legit clip.
    writeFileSync(resolve(srcAbs, 'ok.mp4'), Buffer.from('bytes'));
    // Hidden file — must be skipped.
    writeFileSync(resolve(srcAbs, '.secret.mp4'), Buffer.from('bytes'));
    // Non-mp4 — must be skipped.
    writeFileSync(resolve(srcAbs, 'notes.txt'), Buffer.from('bytes'));

    const manifest = await initMatchClipDrive({ driveDirRel: driveDir, sourceDirRel: sourceDir });
    expect(manifest.clips.length).toBe(1);
    expect(manifest.clips[0]!.path).toBe('/highlights/ok.mp4');
  });

  test('getHighlightsForMatch filters by numeric match id', async () => {
    const { driveDir, sourceDir } = nextTestDirs();
    const srcAbs = resolve(process.cwd(), sourceDir);
    mkdirSync(srcAbs, { recursive: true });
    writeFileSync(resolve(srcAbs, 'first.mp4'), Buffer.from('one'));
    writeFileSync(resolve(srcAbs, 'second.mp4'), Buffer.from('two'));
    writeFileSync(resolve(srcAbs, 'first.mp4.json'), JSON.stringify({ matchId: 100000 }));
    writeFileSync(resolve(srcAbs, 'second.mp4.json'), JSON.stringify({ matchId: 100018 }));
    await initMatchClipDrive({ driveDirRel: driveDir, sourceDirRel: sourceDir });

    const list = getHighlightsForMatch(100018);
    expect(list.length).toBe(1);
    expect(list[0]!.path).toBe('/highlights/second.mp4');

    // Unknown match id yields empty list.
    expect(getHighlightsForMatch(99).length).toBe(0);
    // Non-finite input is rejected.
    expect(getHighlightsForMatch(NaN).length).toBe(0);
  });

  test('sidecar with unknown top-level keys is rejected wholesale', async () => {
    const { driveDir, sourceDir } = nextTestDirs();
    const srcAbs = resolve(process.cwd(), sourceDir);
    mkdirSync(srcAbs, { recursive: true });
    writeFileSync(resolve(srcAbs, 'x.mp4'), Buffer.from('bytes'));
    writeFileSync(
      resolve(srcAbs, 'x.mp4.json'),
      JSON.stringify({ matchId: 5, evil: '<script>', title: 'X' }),
    );
    const manifest = await initMatchClipDrive({ driveDirRel: driveDir, sourceDirRel: sourceDir });
    expect(manifest.clips[0]!.matchId).toBeNull();
    expect(manifest.clips[0]!.title).toBe('x'); // fallback because sidecar rejected
  });

  test('init is idempotent — second call returns the same key', async () => {
    const { driveDir, sourceDir } = nextTestDirs();
    mkdirSync(resolve(process.cwd(), sourceDir), { recursive: true });
    const m1 = await initMatchClipDrive({ driveDirRel: driveDir, sourceDirRel: sourceDir });
    const m2 = await initMatchClipDrive({ driveDirRel: driveDir, sourceDirRel: sourceDir });
    expect(m1.key).toBe(m2.key);
    expect(m1.discoveryKey).toBe(m2.discoveryKey);
  });
});
