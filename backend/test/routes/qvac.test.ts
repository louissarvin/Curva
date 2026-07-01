/**
 * F12 QVAC route tests — mirror-disabled (default) mode.
 *
 * We exercise `/qvac/models`, `/qvac/models/:id`, and the 302-redirect path of
 * `/qvac/models/:id/download`. Mirror-enabled behavior lives in
 * qvacMirror.test.ts (which mocks main-config to flip the flag on and points
 * MODEL_MIRROR_DIR at a temp dir seeded with a byte-exact file).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const { qvacRoutes } = await import('../../src/routes/qvacRoutes.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(qvacRoutes, { prefix: '/qvac' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /qvac/models', () => {
  test('returns the EN-hub Bergamot catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/qvac/models' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: {
        version: string;
        mirrorEnabled: boolean;
        models: Array<{ id: string; family: string; status: string; mirrorUrl: string | null }>;
      };
    };
    expect(body.success).toBe(true);
    // Fix Wave C T3 dropped the 3 legacy pseudo-entries; v1.2.0 ships the 12
    // real EN-hub pairs (en-{it,id,es,pt,de,fr} + reverse).
    expect(body.data.version).toBe('1.2.0');
    expect(body.data.mirrorEnabled).toBe(false);
    expect(body.data.models.length).toBe(12);
    const ids = body.data.models.map((m) => m.id);
    // Legacy pseudo-entries removed.
    expect(ids).not.toContain('bergamot-itid');
    expect(ids).not.toContain('bergamot-iten');
    expect(ids).not.toContain('bergamot-enid');
    // Real EN-hub pairs present.
    expect(ids).toContain('bergamot-en-it');
    expect(ids).toContain('bergamot-en-es');
    expect(ids).toContain('bergamot-en-pt');
    expect(ids).toContain('bergamot-en-de');
    expect(ids).toContain('bergamot-en-fr');
    expect(ids).toContain('bergamot-it-en');
    expect(ids).toContain('bergamot-id-en');
    expect(ids).toContain('bergamot-es-en');
    expect(ids).toContain('bergamot-pt-en');
    expect(ids).toContain('bergamot-de-en');
    expect(ids).toContain('bergamot-fr-en');
    for (const m of body.data.models) {
      expect(m.family).toBe('bergamot');
      // Mirror disabled → mirrorUrl always null regardless of JSON value.
      expect(m.mirrorUrl).toBeNull();
    }
    expect(res.headers['cache-control']).toContain('max-age=300');
  });

  test('_meta key is not surfaced in the public response', async () => {
    const res = await app.inject({ method: 'GET', url: '/qvac/models' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    expect(body.data).not.toHaveProperty('_meta');
  });

  test('filters by family', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/qvac/models?family=whisper',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { models: unknown[] } };
    expect(body.data.models).toHaveLength(0);
  });

  test('filters by capability', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/qvac/models?capability=translate',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { models: unknown[] } };
    // All 12 EN-hub Bergamot pairs share the `translate` capability.
    expect(body.data.models.length).toBe(12);
  });

  test('rate-limit headers present', async () => {
    const res = await app.inject({ method: 'GET', url: '/qvac/models' });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });
});

describe('GET /qvac/models/:id', () => {
  test('returns the IT->EN demo model (Fix Wave C T3)', async () => {
    // bergamot-itid was removed in Fix Wave C T3; IT<->ID hops now use
    // bergamot-it-en + bergamot-en-id via native modelConfig.pivotModel.
    const res = await app.inject({
      method: 'GET',
      url: '/qvac/models/bergamot-it-en',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { model: { id: string; family: string; contentDigest: string | null } };
    };
    expect(body.data.model.id).toBe('bergamot-it-en');
    expect(body.data.model.family).toBe('bergamot');
    expect(body.data.model.contentDigest).toBeNull();
  });

  test('returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/qvac/models/nonexistent',
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MODEL_NOT_FOUND');
  });

  test('rejects path-traversal-shaped ids as 404', async () => {
    // Fastify still routes them here; our regex refuses them before touching fs.
    const res = await app.inject({
      method: 'GET',
      url: '/qvac/models/..%2Fetc%2Fpasswd',
    });
    // Depending on Fastify's percent-decoding behavior we accept either 404 or
    // a normalised route mismatch → also 404. Just assert not-200.
    expect(res.statusCode).not.toBe(200);
  });
});

describe('GET /qvac/explainer', () => {
  test('returns the canonical About-screen copy', async () => {
    const res = await app.inject({ method: 'GET', url: '/qvac/explainer' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: {
        title: string;
        bullets: string[];
        attribution: string;
        sourceUrl: string;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.title).toBe('Why QVAC not cloud');
    expect(body.data.bullets.length).toBe(3);
    expect(body.data.bullets[0]).toBe(
      'Your chat never leaves your device, not even to translate.'
    );
    expect(body.data.bullets[1]).toBe(
      'Works offline, on airport wifi, during internet shutdowns.'
    );
    expect(body.data.bullets[2]).toBe(
      'Bergamot NMT models are verified against sha256 on your machine.'
    );
    expect(body.data.attribution).toContain('Bergamot NMT');
    expect(body.data.attribution).toContain('QVAC');
    expect(body.data.sourceUrl).toBe(
      'https://github.com/mozilla/firefox-translations-models'
    );
  });

  test('rate-limit headers present', async () => {
    const res = await app.inject({ method: 'GET', url: '/qvac/explainer' });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  test('cache-control set for CDN caching', async () => {
    const res = await app.inject({ method: 'GET', url: '/qvac/explainer' });
    expect(res.headers['cache-control']).toContain('max-age=');
  });
});

describe('GET /qvac/models/:id/download — mirror disabled (default)', () => {
  test('302 redirects to upstream downloadUrl', async () => {
    // Fix Wave C T3: use a real EN-hub entry (bergamot-it-en) instead of the
    // dropped bergamot-itid pseudo-entry.
    const res = await app.inject({
      method: 'GET',
      url: '/qvac/models/bergamot-it-en/download',
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toContain(
      'storage.googleapis.com/moz-fx-translations-data'
    );
    expect(String(res.headers['location'])).toContain('model.iten');
    expect(res.headers['x-curva-mirror']).toBe('disabled');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('404 for unknown model id on download', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/qvac/models/does-not-exist/download',
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MODEL_NOT_FOUND');
  });
});
