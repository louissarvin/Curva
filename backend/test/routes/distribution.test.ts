/**
 * F13 route tests for `/distribution` and `/distribution.pear.json`.
 *
 * Default env has PEAR_APP_KEY unset — both endpoints still return 200 with
 * appKey=null (graceful degradation, not hide-existence). This is the primary
 * demo-day posture until the Pear app team ships a first release.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const { distributionRoutes } = await import('../../src/routes/distributionRoutes.ts');
const appDistribution = await import('../../src/lib/pears/appDistribution.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(distributionRoutes);
  await app.ready();
  appDistribution.__resetForTest();
});

afterAll(async () => {
  await app.close();
  appDistribution.__resetForTest();
});

describe('GET /distribution (disabled default)', () => {
  test('returns 200 with a healthy manifest even when PEAR_APP_KEY unset', async () => {
    const res = await app.inject({ method: 'GET', url: '/distribution' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      error: unknown;
      data: {
        appKey: string | null;
        pearLink: string | null;
        version: string;
        releasedAt: string | null;
        description: string;
        howToInstall: { command: string; url: string; note: string };
        seederRunning: boolean;
        seederUptimeSeconds: number;
        distributionEnabled: boolean;
        mirrors: unknown[];
      };
    };
    expect(body.success).toBe(true);
    expect(body.error).toBeNull();
    expect(body.data.appKey).toBeNull();
    expect(body.data.pearLink).toBeNull();
    expect(body.data.seederRunning).toBe(false);
    expect(body.data.seederUptimeSeconds).toBe(0);
    expect(body.data.distributionEnabled).toBe(false);
    expect(typeof body.data.description).toBe('string');
    expect(body.data.description.length).toBeGreaterThan(0);
    expect(body.data.howToInstall.command).toContain('pear');
    expect(Array.isArray(body.data.mirrors)).toBe(true);
  });

  test('response has Cache-Control header for CDN-friendly TTL', async () => {
    const res = await app.inject({ method: 'GET', url: '/distribution' });
    expect(res.headers['cache-control']).toBeDefined();
    expect(res.headers['cache-control']).toContain('max-age=');
    expect(res.headers['cache-control']).toContain('public');
  });

  test('rate-limit headers present', async () => {
    const res = await app.inject({ method: 'GET', url: '/distribution' });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });
});

describe('GET /distribution.pear.json (machine-readable, flat schema)', () => {
  test('returns the raw Pear-updater envelope (no success/error/data wrapper)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/distribution.pear.json',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      $schema?: string;
      app?: string;
      key?: string | null;
      version?: string;
      released_at?: string | null;
      checksums?: Record<string, string>;
      // Should NOT have the standard wrapper.
      success?: unknown;
      error?: unknown;
      data?: unknown;
    };
    expect(body.$schema).toBe('https://curva.app/schemas/pear-distribution.v1.json');
    expect(body.app).toBe('curva');
    expect(body.key).toBeNull();
    expect(body.version).toBeDefined();
    expect(body.released_at).toBeNull();
    expect(body.checksums).toEqual({});
    // Documented exception: raw flat envelope, no wrapper.
    expect(body.success).toBeUndefined();
    expect(body.error).toBeUndefined();
    expect(body.data).toBeUndefined();
  });

  test('advertises application/json content type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/distribution.pear.json',
    });
    expect(res.headers['content-type']).toContain('application/json');
  });

  test('Cache-Control present for updater tooling', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/distribution.pear.json',
    });
    expect(res.headers['cache-control']).toBeDefined();
    expect(res.headers['cache-control']).toContain('max-age=');
  });
});

describe('config shape', () => {
  test('getConfig() returns AppDistributionConfig matching the manifest', async () => {
    const cfg = appDistribution.getConfig();
    // In the default test env both env vars are unset.
    expect(cfg.appKey).toBeNull();
    expect(cfg.enabled).toBe(false);
    // Manifest and library agree on the same defaults.
    const res = await app.inject({ method: 'GET', url: '/distribution' });
    const body = res.json() as {
      data: { appKey: string | null; distributionEnabled: boolean };
    };
    expect(body.data.appKey).toBe(cfg.appKey);
    expect(body.data.distributionEnabled).toBe(cfg.enabled);
  });
});
