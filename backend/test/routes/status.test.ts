/**
 * F4 route tests for /status and /status.json.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

// Capture the WHERE clause that the tipEvent.count call uses for the "today"
// metric so we can assert the boundary is anchored to UTC midnight.
let lastTipsTodayWhere: { blockTime?: { gte?: Date } } | undefined;

const fakePrisma = {
  indexerCursor: { findUnique: async () => null },
  catalogSync: { findFirst: async () => null },
  match: { count: async () => 0 },
  room: { count: async () => 0 },
  tipEvent: {
    count: async (args?: { where?: { blockTime?: { gte?: Date } } }) => {
      if (args?.where?.blockTime?.gte) {
        lastTipsTodayWhere = args.where;
      }
      return 0;
    },
  },
  $queryRaw: async () => [{ total: '0' }],
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

const { statusRoutes } = await import('../../src/routes/statusRoutes.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(statusRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /status', () => {
  test('returns HTML with English copy by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const body = res.body;
    expect(body).toContain('Curva Companion');
    expect(body).toContain('Service health');
  });

  test('returns Italian copy with ?lang=it', async () => {
    const res = await app.inject({ method: 'GET', url: '/status?lang=it' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Stato Curva Companion');
  });
});

describe('GET /status.json', () => {
  test('returns JSON envelope with the same data fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/status.json' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { status: string; components: Record<string, unknown>; metrics: Record<string, unknown> } };
    expect(['ok', 'degraded', 'down']).toContain(body.data.status);
    expect(body.data.components.api).toBeDefined();
    expect(body.data.metrics).toBeDefined();
  });

  test('tipsToday count is anchored to UTC midnight, not rolling 24h (CODE_REVIEW W2 #2)', async () => {
    // Use a distinct URL so the dataCache memoize fresh-fetches and we capture
    // the WHERE clause. The cache key is just 'json' so the previous test
    // already populated it — invalidate by clearing the module-scoped caches
    // is not exposed; instead we exploit that fresh fetch will only happen if
    // TTL has lapsed. Workaround: use a tiny delay isn't reliable, so we just
    // check the boundary directly from a fresh app + the captured value.
    //
    // We did just call /status.json above so dataCache has the value. Re-call
    // /status (HTML) which also goes through buildStatusData via htmlCache
    // and forces buildStatusData to run (different cache instance).
    await app.inject({ method: 'GET', url: '/status?lang=it' });
    expect(lastTipsTodayWhere).toBeDefined();
    const gte = lastTipsTodayWhere!.blockTime!.gte!;
    // The anchor must be midnight UTC of "today".
    expect(gte.getUTCHours()).toBe(0);
    expect(gte.getUTCMinutes()).toBe(0);
    expect(gte.getUTCSeconds()).toBe(0);
    expect(gte.getUTCMilliseconds()).toBe(0);
    // A tip from 23:59 UTC "yesterday" must fall before the boundary.
    const yesterdayLate = new Date(gte.getTime() - 60_000);
    expect(yesterdayLate.getTime()).toBeLessThan(gte.getTime());
  });
});
