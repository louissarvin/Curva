/**
 * prewarm-models.ts
 *
 * Downloads every model in the QVAC catalog to the mirror directory
 * (MODEL_MIRROR_DIR, default `./tmp/qvac-models`) regardless of the
 * MODEL_MIRROR_ENABLED runtime flag.
 *
 * Purpose: an operator can prewarm the mirror before flipping
 * MODEL_MIRROR_ENABLED=true, so the first Pear-app fetch never times out
 * while the backend downloads a 17 MB Bergamot artefact from upstream.
 *
 * Usage:  bun run prewarm:models
 *
 * Behaviour:
 *   - Iterates every model in `src/data/qvac-models.json`.
 *   - Skips models with status !== 'ready' or contentDigest === null (nothing
 *     to verify against — safer to skip than to serve unverified bytes).
 *   - Streams the download through sha-256 in-flight; on match, atomic-renames
 *     the .tmp file to `<id>.bin` (same rename primitive the worker uses).
 *   - On mismatch, deletes the temp file and moves on. On any other error,
 *     logs and moves on.
 *   - Exit code 0 iff every ready+digest-pinned model is on-disk after the run.
 *
 * The download path deliberately does not import the worker to keep this
 * script boot-safe (no cron scheduling side-effects). We reuse the mirror
 * helpers from src/lib/qvac/mirror.ts, which are pure IO + digest math.
 */

import '../dotenv.ts';

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import axios from 'axios';
import { loadRegistry, type QvacModel } from '../src/lib/qvac/registry.ts';
import {
  ensureMirrorDir,
  getMirrorPath,
  getMirrorTempPath,
  parseExpectedDigestHex,
  promoteTempFile,
  readyMirroredFile,
  removeTempFile,
} from '../src/lib/qvac/mirror.ts';
import { MODEL_DOWNLOAD_MAX_BYTES } from '../src/config/main-config.ts';

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per model

interface Outcome {
  id: string;
  action: 'skipped' | 'already-present' | 'downloaded' | 'digest-mismatch' | 'error';
  detail?: string;
}

const downloadOne = async (m: QvacModel): Promise<Outcome> => {
  const expectedHex = parseExpectedDigestHex(m.contentDigest);
  if (!expectedHex) {
    return { id: m.id, action: 'skipped', detail: 'no digest pinned' };
  }
  if (!m.downloadUrl) {
    return { id: m.id, action: 'skipped', detail: 'no downloadUrl' };
  }
  const ready = await readyMirroredFile(m.id, m.contentDigest);
  if (ready) return { id: m.id, action: 'already-present' };

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
      const cleanup = (err: Error): void => {
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
          cleanup(
            new Error(`exceeded MODEL_DOWNLOAD_MAX_BYTES (${MODEL_DOWNLOAD_MAX_BYTES})`)
          );
          return;
        }
        hash.update(chunk);
      });
      upstream.on('error', (err: Error) => cleanup(err));
      sink!.on('error', (err: Error) => cleanup(err));
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
        detail: `expected ${expectedHex.slice(0, 12)}, got ${actualHex.slice(0, 12)}`,
      };
    }
    await promoteTempFile(m.id);
    return { id: m.id, action: 'downloaded', detail: `${bytesWritten} bytes` };
  } catch (err) {
    await removeTempFile(m.id);
    return { id: m.id, action: 'error', detail: (err as Error)?.message ?? String(err) };
  }
};

const main = async (): Promise<void> => {
  const registry = loadRegistry();
  const ready = registry.models.filter((m) => m.status === 'ready' && m.contentDigest);
  console.log('');
  console.log(`[prewarm-models] catalog ${registry.version}, ${registry.models.length} models total`);
  console.log(`[prewarm-models] ${ready.length} model(s) with status=ready and pinned digest`);
  if (ready.length === 0) {
    console.log('[prewarm-models] nothing to prewarm — every model is pending-upstream.');
    console.log('[prewarm-models] once an operator pins a contentDigest, re-run this script.');
    console.log(`[prewarm-models] mirror path: ${getMirrorPath('placeholder').replace(/placeholder\.bin$/, '')}`);
    process.exit(0);
  }
  let failures = 0;
  for (const m of ready) {
    const outcome = await downloadOne(m);
    if (outcome.action === 'error' || outcome.action === 'digest-mismatch') {
      failures += 1;
      console.error(`[prewarm-models] ${outcome.id}: ${outcome.action} — ${outcome.detail ?? ''}`);
    } else {
      console.log(
        `[prewarm-models] ${outcome.id}: ${outcome.action}${
          outcome.detail ? ' (' + outcome.detail + ')' : ''
        }`
      );
    }
  }
  console.log('');
  console.log(`[prewarm-models] done. failures=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
};

void main().catch((err) => {
  console.error('[prewarm-models] failed:', (err as Error)?.message ?? err);
  process.exit(1);
});
