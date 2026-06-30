/**
 * F12 QVAC model mirror sync worker (optional).
 *
 * Cron `MODEL_MIRROR_SYNC_CRON` (default hourly). No-ops if
 * `MODEL_MIRROR_ENABLED=false` — logs once at startup and never schedules.
 *
 * For each registry model with `status: 'ready'` and a pinned `contentDigest`,
 * if we don't already have a byte-exact copy on disk we stream-download the
 * `downloadUrl` to a `.tmp` file, verify sha-256 in-flight, and atomic-rename
 * on success. Digest mismatch → delete temp, log, skip.
 *
 * Safety envelope:
 *   - `isRunning` flag prevents overlap.
 *   - Download bounded by `MODEL_DOWNLOAD_MAX_BYTES`; excess aborts the stream.
 *   - Never crashes the process; every error is caught and logged.
 *   - Never serves a file with mismatched digest — verification happens before
 *     the rename that makes the file visible to the download route.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import cron from 'node-cron';
import axios from 'axios';
import {
  MODEL_DOWNLOAD_MAX_BYTES,
  MODEL_MIRROR_ENABLED,
  MODEL_MIRROR_SYNC_CRON,
} from '../config/main-config.ts';
import { loadRegistry, type QvacModel } from '../lib/qvac/registry.ts';
import {
  ensureMirrorDir,
  getMirrorPath,
  getMirrorTempPath,
  parseExpectedDigestHex,
  promoteTempFile,
  readyMirroredFile,
  removeMirroredFile,
  removeTempFile,
} from '../lib/qvac/mirror.ts';

let isRunning = false;

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per model (17 MB Bergamot)

interface SyncOutcome {
  id: string;
  action: 'skipped' | 'already-present' | 'downloaded' | 'digest-mismatch' | 'error';
  detail?: string;
}

const downloadOne = async (m: QvacModel): Promise<SyncOutcome> => {
  const expectedHex = parseExpectedDigestHex(m.contentDigest);
  if (!expectedHex) {
    return { id: m.id, action: 'skipped', detail: 'no digest pinned' };
  }
  if (!m.downloadUrl) {
    return { id: m.id, action: 'skipped', detail: 'no downloadUrl' };
  }

  // Already correct on disk? Then nothing to do.
  const ready = await readyMirroredFile(m.id, m.contentDigest);
  if (ready) return { id: m.id, action: 'already-present' };

  // Fresh download to .tmp.
  await ensureMirrorDir();
  await removeTempFile(m.id);
  const tempPath = getMirrorTempPath(m.id);

  let bytesWritten = 0;
  const hash = createHash('sha256');
  let aborted = false;
  let sink: ReturnType<typeof createWriteStream> | null = null;

  try {
    const res = await axios.get(m.downloadUrl, {
      responseType: 'stream',
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    sink = createWriteStream(tempPath);

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const upstream = res.data as NodeJS.ReadableStream;
      const cleanupAndReject = (err: Error): void => {
        if (aborted) return;
        aborted = true;
        try {
          (upstream as unknown as { destroy?: (e?: Error) => void })?.destroy?.(err);
        } catch {
          /* ignore */
        }
        try {
          sink?.destroy();
        } catch {
          /* ignore */
        }
        rejectPromise(err);
      };

      upstream.on('data', (chunk: Buffer) => {
        if (aborted) return;
        bytesWritten += chunk.length;
        if (bytesWritten > MODEL_DOWNLOAD_MAX_BYTES) {
          cleanupAndReject(
            new Error(
              `download exceeded MODEL_DOWNLOAD_MAX_BYTES (${MODEL_DOWNLOAD_MAX_BYTES})`
            )
          );
          return;
        }
        hash.update(chunk);
      });
      upstream.on('error', (err: Error) => cleanupAndReject(err));
      sink!.on('error', (err: Error) => cleanupAndReject(err));
      sink!.on('finish', () => {
        if (!aborted) resolvePromise();
      });
      upstream.pipe(sink!);
    });

    const actualHex = hash.digest('hex').toLowerCase();
    if (actualHex !== expectedHex) {
      await removeTempFile(m.id);
      return {
        id: m.id,
        action: 'digest-mismatch',
        detail: `expected ${expectedHex.slice(0, 12)}…, got ${actualHex.slice(0, 12)}…`,
      };
    }

    // Atomic rename → the download route now sees the byte-exact file.
    await promoteTempFile(m.id);
    return { id: m.id, action: 'downloaded', detail: `${bytesWritten} bytes` };
  } catch (err) {
    await removeTempFile(m.id);
    return {
      id: m.id,
      action: 'error',
      detail: (err as Error)?.message ?? String(err),
    };
  }
};

const tick = async (): Promise<void> => {
  if (!MODEL_MIRROR_ENABLED) return;
  if (isRunning) {
    console.log('[modelMirrorSyncWorker] Previous run still active, skipping...');
    return;
  }
  isRunning = true;
  try {
    const models = loadRegistry().models.filter((m) => m.status === 'ready');
    if (models.length === 0) {
      // Not an error — most demos ship with `pending-upstream` entries.
      return;
    }
    for (const m of models) {
      const outcome = await downloadOne(m);
      if (outcome.action === 'error' || outcome.action === 'digest-mismatch') {
        console.error(
          `[modelMirrorSyncWorker] ${outcome.action} for ${outcome.id}: ${outcome.detail ?? ''}`
        );
        // Purge whatever we might have on disk so the download route falls
        // through to redirect mode instead of streaming corrupt bytes.
        if (outcome.action === 'digest-mismatch') {
          await removeMirroredFile(m.id).catch(() => undefined);
        }
      } else {
        console.log(
          `[modelMirrorSyncWorker] ${outcome.id}: ${outcome.action}${
            outcome.detail ? ' (' + outcome.detail + ')' : ''
          }`
        );
      }
    }
  } catch (err) {
    console.error(
      '[modelMirrorSyncWorker] Tick error:',
      (err as Error)?.message ?? String(err)
    );
  } finally {
    isRunning = false;
  }
};

export const startModelMirrorSyncWorker = (): void => {
  if (!MODEL_MIRROR_ENABLED) {
    console.log(
      '[modelMirrorSyncWorker] Mirror disabled — worker not scheduled. ' +
        'Enable with MODEL_MIRROR_ENABLED=true.'
    );
    return;
  }
  console.log(`[modelMirrorSyncWorker] Scheduled: ${MODEL_MIRROR_SYNC_CRON}`);
  cron.schedule(MODEL_MIRROR_SYNC_CRON, tick);
};

/**
 * Test-only hooks. Not called by production code.
 */
export const __tickForTest = tick;
export const __resetForTest = (): void => {
  isRunning = false;
};

// Silence "unused" warning about tempPath variable — worker gets it via
// getMirrorTempPath(m.id) inside downloadOne. Function noop kept for parity
// with other workers that expose isRunningForTest.
export const __getIsRunningForTest = (): boolean => isRunning;

// Re-export for the manifest / status page in case we later want to surface
// mirrored-file listing there.
export { getMirrorPath };
