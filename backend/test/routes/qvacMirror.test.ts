/**
 * F12 route tests — mirror-enabled mode.
 *
 * We mock main-config to flip MODEL_MIRROR_ENABLED on and redirect
 * MODEL_MIRROR_DIR at a temp dir, then seed a byte-exact file for a synthetic
 * model registered via env override (QVAC_MODEL_<ID>_DIGEST). This lets us
 * exercise the stream + range paths without touching the shipped catalog.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, promises as fsp, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';

// -----------------------------------------------------------------------------
// Prepare the temp mirror dir + a seeded synthetic file BEFORE any import.
// -----------------------------------------------------------------------------

const TMP_DIR = mkdtempSync(join(tmpdir(), 'curva-qvac-route-'));

// Seed a byte-exact copy for the primary demo model (bergamot-it-en). We'll
// override the JSON's `contentDigest: null` via the env-override hook so the
// registry considers the file valid.
const PAYLOAD = Buffer.from(
  'curva-mirror-file-content-for-bergamot-it-en-fixture-payload',
  'utf8'
);
// Repeat the payload a few times so we have enough bytes for a range slice.
const BIG_PAYLOAD = Buffer.concat([PAYLOAD, PAYLOAD, PAYLOAD, PAYLOAD]);
const DIGEST_HEX = createHash('sha256').update(BIG_PAYLOAD).digest('hex');

writeFileSync(join(TMP_DIR, 'bergamot-it-en.bin'), BIG_PAYLOAD);

// Env override: point the primary model's digest at our fixture. The loader
// reads process.env at import time so we must set this BEFORE loading the
// registry / route module.
process.env.QVAC_MODEL_BERGAMOT_IT_EN_DIGEST = `sha256:${DIGEST_HEX}`;
// Reset the memoised registry so it reads the override — the previous test
// file (qvac.test.ts) may have populated the cache.

// -----------------------------------------------------------------------------
// Mock main-config: enable mirror + point the dir at TMP_DIR. Everything else
// forwarded to the real config module.
// -----------------------------------------------------------------------------

const realConfig = await import('../../src/config/main-config.ts');
mock.module('../../src/config/main-config.ts', () => ({
  ...realConfig,
  MODEL_MIRROR_ENABLED: true,
  MODEL_MIRROR_DIR: TMP_DIR,
}));

// Reset the registry cache so the env override we set above takes effect on
// first load inside the route module.
const registryModule = await import('../../src/lib/qvac/registry.ts');
registryModule.__resetForTest();

// Now import route module — it will pick up the mocked config.
const { qvacRoutes } = await import('../../src/routes/qvacRoutes.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;
let baseUrl = '';

// Real HTTP request helper. Streaming responses (createReadStream via
// reply.send) hang under fastify.inject() on Bun (see backend engineer memory
// `feedback-fastify-stream-inject`), so download endpoints are exercised via a
// real listen port. Non-streaming routes still use app.inject when convenient.
interface RawResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}
const rawGet = (path: string, headers: Record<string, string> = {}): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        headers,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(qvacRoutes, { prefix: '/qvac' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr && typeof addr === 'object') {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  } else {
    throw new Error('failed to determine listen address');
  }
});

afterAll(async () => {
  await app.close();
  await fsp.rm(TMP_DIR, { recursive: true, force: true }).catch(() => undefined);
  delete process.env.QVAC_MODEL_BERGAMOT_IT_EN_DIGEST;
  registryModule.__resetForTest();
});

describe('GET /qvac/models (mirror enabled)', () => {
  test('populates mirrorUrl for the seeded model', async () => {
    const res = await app.inject({ method: 'GET', url: '/qvac/models' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: {
        mirrorEnabled: boolean;
        models: Array<{ id: string; mirrorUrl: string | null }>;
      };
    };
    expect(body.data.mirrorEnabled).toBe(true);
    const itid = body.data.models.find((m) => m.id === 'bergamot-it-en');
    expect(itid?.mirrorUrl).toBe('/qvac/models/bergamot-it-en/download');
    // Non-seeded models still have mirrorUrl null.
    const other = body.data.models.find((m) => m.id === 'bergamot-en-id');
    expect(other?.mirrorUrl).toBeNull();
  });
});

describe('GET /qvac/models/:id/download (mirror enabled)', () => {
  test('streams the full file with correct headers', async () => {
    const res = await rawGet('/qvac/models/bergamot-it-en/download');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe(String(BIG_PAYLOAD.length));
    expect(String(res.headers['content-digest'])).toContain('sha-256=:');
    expect(res.headers['etag']).toBe(`"${DIGEST_HEX}"`);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['x-curva-mirror']).toBe('hit');
    expect(String(res.headers['cache-control'])).toContain('immutable');
    expect(res.body.length).toBe(BIG_PAYLOAD.length);
    expect(res.body.equals(BIG_PAYLOAD)).toBe(true);
  });

  test('honours a byte range → 206 with correct Content-Range', async () => {
    const size = BIG_PAYLOAD.length;
    const start = 10;
    const end = 40;
    const res = await rawGet('/qvac/models/bergamot-it-en/download', {
      range: `bytes=${start}-${end}`,
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes ${start}-${end}/${size}`);
    expect(res.headers['content-length']).toBe(String(end - start + 1));
    expect(res.body.length).toBe(end - start + 1);
    expect(res.body.equals(BIG_PAYLOAD.subarray(start, end + 1))).toBe(true);
  });

  test('honours a suffix range', async () => {
    const size = BIG_PAYLOAD.length;
    const res = await rawGet('/qvac/models/bergamot-it-en/download', {
      range: 'bytes=-20',
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes ${size - 20}-${size - 1}/${size}`);
    expect(res.body.equals(BIG_PAYLOAD.subarray(size - 20))).toBe(true);
  });

  test('out-of-bounds range → 416 with Content-Range: */size', async () => {
    const size = BIG_PAYLOAD.length;
    const res = await rawGet('/qvac/models/bergamot-it-en/download', {
      range: `bytes=${size + 100}-${size + 200}`,
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${size}`);
    const body = JSON.parse(res.body.toString('utf8')) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_RANGE');
  });

  test('if-none-match on the etag → 304', async () => {
    const res = await rawGet('/qvac/models/bergamot-it-en/download', {
      'if-none-match': `"${DIGEST_HEX}"`,
    });
    expect(res.statusCode).toBe(304);
    expect(res.headers['etag']).toBe(`"${DIGEST_HEX}"`);
  });

  test('mirror enabled but file missing → 302 redirect to upstream', async () => {
    // bergamot-en-id has no seeded file on disk.
    const res = await rawGet('/qvac/models/bergamot-en-id/download');
    // No env override on this one means contentDigest stays null → the
    // unverified fallback path fires (also redirects, header 'unverified').
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toContain(
      'storage.googleapis.com/moz-fx-translations-data'
    );
    expect(res.headers['x-curva-mirror']).toBe('unverified');
  });
});
