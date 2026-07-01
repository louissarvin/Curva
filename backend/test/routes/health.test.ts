/**
 * healthRoutes tests.
 *
 * Covers:
 *   - SECURITY_AUDIT MED-04: lastSubmittedTxHash is redacted (shortened) or null.
 *   - SECURITY_AUDIT W2-HIGH-03 mirror: /metrics/live counters exclude demo rows
 *     (this is exercised elsewhere too; here we just assert the endpoint shape).
 *
 * The facilitator module snapshots RELAY_SPONSOR_PK at import time. We import
 * the routes, then use __setSponsorForTest to flip on the facilitator so the
 * route surfaces the facilitator section.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { ethers } from 'ethers';

// -----------------------------------------------------------------------------
// Prisma stub
// -----------------------------------------------------------------------------

const FULL_HASH = '0x' + 'ab'.repeat(32); // 66 chars

const fakePrisma = {
  $queryRaw: async () => [{ '?column?': 1 }],
  indexerCursor: { findUnique: async () => null },
  catalogSync: { findFirst: async () => null },
  match: { count: async () => 0 },
  room: {
    count: async () => 0,
    findMany: async () => [],
  },
  tipEvent: {
    count: async () => 0,
    findMany: async () => [],
  },
  facilitatorTx: {
    findFirst: async () => ({ txHash: FULL_HASH }),
  },
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

const facilitatorModule = await import('../../src/lib/evm/facilitator.ts');
const { __setSponsorForTest, __resetBalanceCacheForTest } = facilitatorModule;

const { healthRoutes } = await import('../../src/routes/healthRoutes.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;

// Redacted shape from shortenAddress(x, 10, 6): 10 hex chars + "..." + 6 hex.
// Note shortenAddress drops the 0x prefix logic; we just assert the shape it
// produces for a 66-char 0x-prefixed hash.
const REDACTED_SHAPE = /^0x[a-fA-F0-9]{8}\.{3}[a-fA-F0-9]{6}$/;

beforeAll(async () => {
  __setSponsorForTest(new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32))));
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(healthRoutes, { prefix: '/health' });
  await app.register(healthRoutes, { prefix: '/metrics' });
  await app.ready();
});

afterAll(async () => {
  __setSponsorForTest(null);
  __resetBalanceCacheForTest();
  await app.close();
});

describe('GET /health — facilitator redaction', () => {
  test('lastSubmittedTxHash is either null or the redacted 10/6 shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json() as {
      data: {
        facilitator: {
          enabled: boolean;
          lastSubmittedTxHash: string | null;
        };
      };
    };
    const txh = body.data.facilitator.lastSubmittedTxHash;
    // Must never be the full 66-char hash.
    expect(txh).not.toBe(FULL_HASH);
    if (txh !== null) {
      // shortenAddress(hash, 10, 6) yields '0x' + 8 hex + '...' + 6 hex.
      expect(txh).toMatch(REDACTED_SHAPE);
    }
  });
});

describe('GET /metrics/live — public shape', () => {
  test('responds 200 and includes the expected counters', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics/live' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { activeRooms: number; indexedTips: number; lastTips: unknown[] };
    };
    expect(typeof body.data.activeRooms).toBe('number');
    expect(typeof body.data.indexedTips).toBe('number');
    expect(Array.isArray(body.data.lastTips)).toBe(true);
  });
});
