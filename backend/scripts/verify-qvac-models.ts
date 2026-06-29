/**
 * verify-qvac-models.ts
 *
 * For every model in the QVAC catalog, fetch its `downloadUrl` (streaming,
 * bounded by MODEL_DOWNLOAD_MAX_BYTES), compute the sha-256 in-flight, and
 * print the actual size + digest so an operator can paste it back into
 * `src/data/qvac-models.json`.
 *
 * The script NEVER modifies the JSON. It only prints. This is a one-shot
 * verification tool for pre-flight ops, not a scheduled job.
 *
 * Usage:  bun run verify:qvac-models
 *
 * Output shape (one block per model):
 *   [verify-qvac-models] bergamot-it-en
 *     url:    https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/...
 *     status: 200
 *     bytes:  17825792
 *     sha256: <hex>
 *     paste:  "contentDigest": "sha256:<hex>", "size": 17825792
 *
 * Exit code is 0 iff every URL responded 2xx and the bytes fit within
 * MODEL_DOWNLOAD_MAX_BYTES.
 */

import '../dotenv.ts';

import { createHash } from 'node:crypto';
import axios from 'axios';
import { loadRegistry } from '../src/lib/qvac/registry.ts';
import { MODEL_DOWNLOAD_MAX_BYTES } from '../src/config/main-config.ts';

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

interface VerifyResult {
  id: string;
  url: string;
  ok: boolean;
  status: number | null;
  bytes: number;
  sha256: string | null;
  error: string | null;
}

const hashOne = async (id: string, url: string): Promise<VerifyResult> => {
  const hash = createHash('sha256');
  let bytes = 0;
  let status: number | null = null;
  try {
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    status = res.status;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const upstream = res.data as NodeJS.ReadableStream;
      let aborted = false;
      const fail = (err: Error): void => {
        if (aborted) return;
        aborted = true;
        try {
          (upstream as unknown as { destroy?: (e?: Error) => void })?.destroy?.(err);
        } catch {
          /* ignore */
        }
        rejectPromise(err);
      };
      upstream.on('data', (chunk: Buffer) => {
        if (aborted) return;
        bytes += chunk.length;
        if (bytes > MODEL_DOWNLOAD_MAX_BYTES) {
          fail(new Error(`exceeded MODEL_DOWNLOAD_MAX_BYTES (${MODEL_DOWNLOAD_MAX_BYTES})`));
          return;
        }
        hash.update(chunk);
      });
      upstream.on('error', (err: Error) => fail(err));
      upstream.on('end', () => {
        if (!aborted) resolvePromise();
      });
    });
    return {
      id,
      url,
      ok: true,
      status,
      bytes,
      sha256: hash.digest('hex').toLowerCase(),
      error: null,
    };
  } catch (err) {
    return {
      id,
      url,
      ok: false,
      status,
      bytes,
      sha256: null,
      error: (err as Error)?.message ?? String(err),
    };
  }
};

const main = async (): Promise<void> => {
  const registry = loadRegistry();
  console.log('');
  console.log(`[verify-qvac-models] catalog ${registry.version}, ${registry.models.length} models`);
  console.log('');
  let failures = 0;
  for (const m of registry.models) {
    console.log(`[verify-qvac-models] ${m.id}`);
    console.log(`  url:    ${m.downloadUrl}`);
    const r = await hashOne(m.id, m.downloadUrl);
    if (!r.ok) {
      failures += 1;
      console.log(`  status: ${r.status ?? 'n/a'}`);
      console.log(`  error:  ${r.error}`);
      console.log('');
      continue;
    }
    console.log(`  status: ${r.status}`);
    console.log(`  bytes:  ${r.bytes}`);
    console.log(`  sha256: ${r.sha256}`);
    console.log(`  paste:  "contentDigest": "sha256:${r.sha256}", "size": ${r.bytes}`);
    console.log('');
  }
  console.log(`[verify-qvac-models] done. failures=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
};

void main().catch((err) => {
  console.error('[verify-qvac-models] failed:', (err as Error)?.message ?? err);
  process.exit(1);
});
