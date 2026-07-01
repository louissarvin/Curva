/**
 * F10 route tests for /tips ?chainId= validation + propagation.
 *
 * Asserts:
 *   - 400 CHAIN_UNSUPPORTED on unknown/disabled/garbage chainId.
 *   - 200 when chainId matches an enabled chain.
 *   - The chainId where-clause filter reaches the underlying Prisma call.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

let lastTipEventWhere: Record<string, unknown> | null = null;

const fakePrisma = {
  tipEvent: {
    findMany: async (args: { where?: Record<string, unknown> }) => {
      lastTipEventWhere = args.where ?? null;
      return [];
    },
  },
  room: {
    findMany: async () => [],
    findUnique: async () => null,
  },
  $queryRaw: async () => [{ total: '0', count: 0n }],
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

const { tipRoutes } = await import('../../src/routes/tipRoutes.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(tipRoutes, { prefix: '/tips' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const VALID_ADDR = '0x1234567890123456789012345678901234567890';

describe('GET /tips/:address with ?chainId=', () => {
  test('200 when no chainId is supplied (queries all enabled chains)', async () => {
    lastTipEventWhere = null;
    const res = await app.inject({ method: 'GET', url: `/tips/${VALID_ADDR}` });
    expect(res.statusCode).toBe(200);
    // Without ?chainId, the where clause must NOT carry a chainId predicate.
    expect((lastTipEventWhere ?? {}).chainId).toBeUndefined();
  });

  test('200 + chainId predicate when ?chainId matches an enabled chain', async () => {
    lastTipEventWhere = null;
    const res = await app.inject({
      method: 'GET',
      url: `/tips/${VALID_ADDR}?chainId=11155111`,
    });
    expect(res.statusCode).toBe(200);
    expect((lastTipEventWhere ?? {}).chainId).toBe(11155111);
  });

  test('200 with meta.warning CHAIN_DISABLED on a configured-but-disabled chainId', async () => {
    // ADR-009 + W3 remediation: known-but-disabled chains return 200 with an
    // empty result and a CHAIN_DISABLED warning in the data envelope. 9746
    // (Plasma) is configured in chains.json but disabled by default.
    lastTipEventWhere = null;
    const res = await app.inject({
      method: 'GET',
      url: `/tips/${VALID_ADDR}?chainId=9746`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { meta?: { warning: string }; tips: unknown[] } };
    expect(body.data.meta?.warning).toBe('CHAIN_DISABLED');
    // The disabled chain predicate still reaches the query (returns empty).
    expect((lastTipEventWhere ?? {}).chainId).toBe(9746);
  });

  test('400 on an unknown chainId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tips/${VALID_ADDR}?chainId=99999`,
    });
    expect(res.statusCode).toBe(400);
  });

  test('400 on a malformed chainId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tips/${VALID_ADDR}?chainId=abc`,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /tips/:address/total with ?chainId=', () => {
  test('200 with chainIds echoed in the data envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tips/${VALID_ADDR}/total?chainId=11155111`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { chainIds: number[] } };
    expect(body.data.chainIds).toEqual([11155111]);
  });

  test('200 without ?chainId returns the enabled-chains set', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tips/${VALID_ADDR}/total`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { chainIds: number[] } };
    expect(body.data.chainIds).toEqual([11155111]);
  });

  test('200 with meta.warning CHAIN_DISABLED on disabled chainId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/tips/${VALID_ADDR}/total?chainId=9746`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { chainIds: number[]; meta?: { warning: string } };
    };
    expect(body.data.chainIds).toEqual([9746]);
    expect(body.data.meta?.warning).toBe('CHAIN_DISABLED');
  });
});
