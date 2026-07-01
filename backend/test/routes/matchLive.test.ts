/**
 * F7 route tests for GET /matches/:id/live.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

// Ensure live-data is "enabled" for the route so the goals[] / minute fields
// are populated. The route reads FOOTBALL_DATA_API_KEY directly from
// main-config so we set it before importing the module under test.
process.env.FOOTBALL_DATA_API_KEY = 'test-key';

const fakeMatch = {
  id: 'cmatchlive1',
  externalId: 12345,
  status: 'live' as const,
  homeScore: 1,
  awayScore: 0,
  currentMinute: 23,
  lastSyncedAt: new Date('2026-06-15T19:25:00.000Z'),
};

const fakePrisma = {
  match: {
    findUnique: async (args: { where: { id?: string; externalId?: number } }) => {
      if (
        args.where.id === fakeMatch.id ||
        args.where.externalId === fakeMatch.externalId
      ) {
        return fakeMatch;
      }
      return null;
    },
  },
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

// Seed the in-memory goal log so the route returns the goals[] array.
const { append, reset } = await import('../../src/lib/liveMatch/goalLog.ts');
const { matchLiveRoutes } = await import('../../src/routes/matchLiveRoutes.ts');
const Fastify = (await import('fastify')).default;

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  reset();
  append('cmatchlive1', {
    minute: 17,
    team: 'home',
    scorer: 'Vinicius Junior',
    homeScoreAfter: 1,
    awayScoreAfter: 0,
    observedAt: Date.now(),
  });

  app = Fastify({ logger: false });
  // Mimic the F9 preHandler that populates request.lang.
  app.decorateRequest('lang', 'en');
  app.addHook('preHandler', async (req) => {
    const q = (req.query as { lang?: string }) || {};
    const lang = q.lang;
    if (lang === 'it' || lang === 'id' || lang === 'en') (req as { lang: string }).lang = lang;
  });
  await app.register(matchLiveRoutes, { prefix: '/matches' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  reset();
});

describe('GET /matches/:id/live', () => {
  test('404 for unknown matchId', async () => {
    const res = await app.inject({ method: 'GET', url: '/matches/nope-cuid/live' });
    expect(res.statusCode).toBe(404);
  });

  test('returns DB state + goal log', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/matches/cmatchlive1/live',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: {
        matchId: string;
        externalId: number;
        status: string;
        statusLabel: string;
        currentMinute: number | null;
        homeScore: number | null;
        awayScore: number | null;
        liveDataEnabled: boolean;
        goals: Array<{ minute: number; scorer: string; team: 'home' | 'away' }>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.matchId).toBe('cmatchlive1');
    expect(body.data.externalId).toBe(12345);
    expect(body.data.status).toBe('live');
    expect(body.data.currentMinute).toBe(23);
    expect(body.data.homeScore).toBe(1);
    expect(body.data.awayScore).toBe(0);
    expect(body.data.liveDataEnabled).toBe(true);
    expect(body.data.goals.length).toBe(1);
    expect(body.data.goals[0]!.scorer).toBe('Vinicius Junior');
  });

  test('lookup by numeric externalId works', async () => {
    const res = await app.inject({ method: 'GET', url: '/matches/12345/live' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { matchId: string } };
    expect(body.data.matchId).toBe('cmatchlive1');
  });

  test('i18n statusLabel switches with ?lang=it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/matches/cmatchlive1/live?lang=it',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { statusLabel: string } };
    expect(body.data.statusLabel).toBe('Dal vivo');
  });

  test('i18n statusLabel switches with ?lang=id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/matches/cmatchlive1/live?lang=id',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { statusLabel: string } };
    expect(body.data.statusLabel).toBe('Live');
  });

  test('validation: id too long', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/matches/' + 'x'.repeat(100) + '/live',
    });
    expect(res.statusCode).toBe(400);
  });
});
