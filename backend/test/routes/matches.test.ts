/**
 * Route tests for /matches using a stub Prisma client.
 *
 * We do NOT exercise the database here. We replace `prismaQuery` via Bun's
 * `mock.module` with a fake that returns canned rows, then assert that the
 * route handler shapes responses correctly and enforces validation.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

const fakeMatch = {
  id: 'c' + 'a'.repeat(24),
  externalId: 100001,
  kickoffUtc: new Date('2026-06-11T17:00:00.000Z'),
  stage: 'group',
  status: 'scheduled',
  groupLabel: 'A',
  homeScore: null,
  awayScore: null,
  venue: null,
  homeTeam: { id: 'h1', code: 'MEX', name: 'Mexico', flagUrl: 'https://flagcdn.com/mx.svg', groupLabel: 'A' },
  awayTeam: { id: 'h2', code: 'RSA', name: 'South Africa', flagUrl: 'https://flagcdn.com/za.svg', groupLabel: 'A' },
};

const fakePrisma = {
  match: {
    findMany: async () => [fakeMatch],
    count: async () => 1,
    findUnique: async (args: { where: { id?: string; externalId?: number } }) => {
      if (args.where.id === fakeMatch.id || args.where.externalId === fakeMatch.externalId) return fakeMatch;
      return null;
    },
  },
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

// Import AFTER mocking
const { matchRoutes } = await import('../../src/routes/matchRoutes.ts');
const Fastify = (await import('fastify')).default;

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(matchRoutes, { prefix: '/matches' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /matches', () => {
  test('returns matches with pagination', async () => {
    const res = await app.inject({ method: 'GET', url: '/matches' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: boolean; data: { matches: unknown[]; pagination: { total: number } } };
    expect(body.success).toBe(true);
    expect(body.data.matches.length).toBe(1);
    expect(body.data.pagination.total).toBe(1);
  });

  test('rejects invalid stage', async () => {
    const res = await app.inject({ method: 'GET', url: '/matches?stage=bogus' });
    expect(res.statusCode).toBe(400);
  });

  test('rejects invalid from date', async () => {
    const res = await app.inject({ method: 'GET', url: '/matches?from=not-a-date' });
    expect(res.statusCode).toBe(400);
  });

  test('accepts valid filters', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/matches?stage=group&status=scheduled&from=2026-06-11T00:00:00.000Z',
    });
    expect(res.statusCode).toBe(200);
  });

  test('clamps limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/matches?limit=9999' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { pagination: { limit: number } } };
    expect(body.data.pagination.limit).toBeLessThanOrEqual(200);
  });
});

describe('GET /matches/today', () => {
  test('returns wrapper', async () => {
    const res = await app.inject({ method: 'GET', url: '/matches/today' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: boolean; data: { matches: unknown[] } };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.matches)).toBe(true);
  });
});

describe('GET /matches/:id', () => {
  test('finds by cuid', async () => {
    const res = await app.inject({ method: 'GET', url: `/matches/${fakeMatch.id}` });
    expect(res.statusCode).toBe(200);
  });
  test('finds by externalId', async () => {
    const res = await app.inject({ method: 'GET', url: `/matches/${fakeMatch.externalId}` });
    expect(res.statusCode).toBe(200);
  });
  test('returns 404 for unknown', async () => {
    const res = await app.inject({ method: 'GET', url: '/matches/c' + 'z'.repeat(24) });
    expect(res.statusCode).toBe(404);
  });
});
