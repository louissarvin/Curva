/**
 * Final Fix Wave T1: /relay/info surfaces the real Hyperswarm Noise pubkey
 * captured from the seeder subprocess. Regression coverage for the pre-fix
 * behavior that returned sha256(SEEDER_NOISE_SEED) — which is NOT a valid
 * DHT-resolvable pubkey — and therefore silently no-op'd CURVA_FORCE_RELAY=1
 * on demo day.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

// The route reads seederSupervisor's ENABLE_SEEDER flag (isEnabled()). We stub
// the module so tests can flip enabled state and pubkey without spawning a
// real Bare subprocess.

let enabled = true;
let pubkey: string | null = null;

// Full stub of the seederSupervisor public surface. Partial stubs leak to
// other tests via Bun's module cache (see agent memory:
// feedback_test_module_mocks). Every method actually consumed by any route
// or worker must be present so a later test importing the shared module
// doesn't get an undefined-method TypeError.
mock.module('../../src/lib/pears/seeder.ts', () => ({
  seederSupervisor: {
    isEnabled: () => enabled,
    getNoisePubkey: () => pubkey,
    // Return values that mirror a "healthy, empty" seeder: spawn/stop succeed,
    // telemetry is absent, counts are zero. This keeps other test files that
    // exercise the shared module happy when Bun's cache leaks the stub.
    spawnRoom: (_slug: string) => true,
    stopRoom: (_slug: string) => true,
    getTelemetry: (_slug: string) => null,
    getAllSlugs: () => [],
    getActiveRoomCount: () => 0,
    getTotalPeers: () => 0,
    shutdown: async () => {},
    __setNoisePubkeyForTest: (_hex: string | null) => {},
  },
}));

const { relayRoutes } = await import('../../src/routes/relayRoutes.ts');
const Fastify = (await import('fastify')).default;

const app = Fastify({ logger: false });
await app.register(relayRoutes, { prefix: '/relay' });

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // Reset stub state so any test file that lands on our leaked mock later gets
  // "seeder disabled" — the safest default (matches real backend when
  // ENABLE_SEEDER=false).
  enabled = false;
  pubkey = null;
});

describe('GET /relay/info', () => {
  test('returns 503 with Retry-After when seeder is up but pubkey not captured', async () => {
    enabled = true;
    pubkey = null;
    const res = await app.inject({ method: 'GET', url: '/relay/info' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    const body = res.json() as {
      success: boolean;
      error: { code: string; message: string } | null;
    };
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('SEEDER_NOT_READY');
  });

  test('returns the captured Noise pubkey once the seeder is ready', async () => {
    enabled = true;
    pubkey = 'aa'.repeat(32); // 64-char lowercase hex, 32-byte pubkey shape
    const res = await app.inject({ method: 'GET', url: '/relay/info' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: { pubkey: string; regions: string[]; swarmKey: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.pubkey).toBe(pubkey);
    expect(body.data.regions.length).toBeGreaterThan(0);
    expect(body.data.swarmKey).toMatch(/^[0-9a-f]{64}$/);
  });

  test('when seeder disabled, returns 200 with note and null pubkey', async () => {
    enabled = false;
    pubkey = null;
    const res = await app.inject({ method: 'GET', url: '/relay/info' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: { pubkey: string | null; note: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.pubkey).toBeNull();
    expect(body.data.note).toContain('seeder disabled');
  });

  test('response never leaks the raw SEEDER_NOISE_SEED', async () => {
    enabled = true;
    pubkey = 'bb'.repeat(32);
    const res = await app.inject({ method: 'GET', url: '/relay/info' });
    // Explicit assertion: no field ever surfaces the seed bytes.
    const raw = res.body;
    // process.env.SEEDER_NOISE_SEED may be undefined in test env; guard.
    const seed = process.env.SEEDER_NOISE_SEED;
    if (seed && seed.length > 0) {
      expect(raw.includes(seed)).toBe(false);
    }
  });
});
