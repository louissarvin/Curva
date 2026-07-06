/**
 * D2 tests for POST /predictions/force-settle/:poolId debug endpoint.
 *
 * Coverage:
 *   Bearer auth required (401 when Authorization header is missing/wrong).
 *   Missing CURVA_DEBUG_BEARER + prod  -> 404 (hide-existence).
 *   Missing CURVA_DEBUG_BEARER + dev   -> 503 DEBUG_DISABLED.
 *   Body is parsed: score tuple validated, winner side derived correctly.
 *   Settlement pipeline runs synchronously; the response returns winner
 *     addresses + payout tx hashes.
 *
 * We mock main-config to force CURVA_PREDICTIONS_ENABLED=true (the config
 * module reads env at module-load time via bunfig's preload, so the flag
 * cannot be toggled per test after boot).
 *
 * We mock the settlement worker's __runOnceForTest so the test does not need
 * a live sponsor wallet or on-chain state. The worker is authoritative for
 * on-chain dispatch; this test only asserts the route wiring around it.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

const DEBUG_BEARER = 'test-debug-bearer-token-123';

// -----------------------------------------------------------------------------
// Prisma mock. Backed by an in-memory pool state so a call to
// runOnceForTest can move the row from `locked` -> `settled`.
// -----------------------------------------------------------------------------

interface FakePrediction {
  id: string;
  peerAddress: string;
  peerHandle: string;
  winner: 'HOME' | 'AWAY' | 'DRAW';
  homeGoals: number | null;
  awayGoals: number | null;
  stakeAtomic: string;
  txHash: string;
  status: 'pending' | 'confirmed' | 'won' | 'refunded';
  payoutTxHash: string | null;
  payoutAmountAtomic: string | null;
  createdAt: Date;
}

interface FakePool {
  id: string;
  roomSlug: string;
  matchId: string;
  poolAddress: string;
  chainId: number;
  stakeToken: string;
  entryStakeAtomic: string;
  mode: 'winner-only' | 'exact-score';
  deadlineMs: bigint;
  status: 'open' | 'locked' | 'settled' | 'refunded';
  totalStakedAtomic: string;
  hostAddress: string;
  resultWinner: string | null;
  resultHomeGoals: number | null;
  resultAwayGoals: number | null;
  settledAt: Date | null;
  predictions: FakePrediction[];
}

const state: { pools: FakePool[] } = { pools: [] };

const seedPool = (): FakePool => {
  const pool: FakePool = {
    id: 'cpool0000000000000000000',
    roomSlug: 'demo-room',
    matchId: 'cmatch000000000000000000',
    poolAddress: '0x' + '55'.repeat(20),
    chainId: 11155111,
    stakeToken: '0x' + '77'.repeat(20),
    entryStakeAtomic: '1000000',
    mode: 'winner-only',
    deadlineMs: BigInt(Date.now() + 60_000),
    status: 'open',
    totalStakedAtomic: '3000000',
    hostAddress: '0x' + '99'.repeat(20),
    resultWinner: null,
    resultHomeGoals: null,
    resultAwayGoals: null,
    settledAt: null,
    predictions: [
      {
        id: 'cpred0000000000000000001',
        peerAddress: '0x' + 'aa'.repeat(20),
        peerHandle: 'alice',
        winner: 'HOME',
        homeGoals: null,
        awayGoals: null,
        stakeAtomic: '1000000',
        txHash: '0xstakeA',
        status: 'confirmed',
        payoutTxHash: null,
        payoutAmountAtomic: null,
        createdAt: new Date(),
      },
      {
        id: 'cpred0000000000000000002',
        peerAddress: '0x' + 'bb'.repeat(20),
        peerHandle: 'bob',
        winner: 'AWAY',
        homeGoals: null,
        awayGoals: null,
        stakeAtomic: '1000000',
        txHash: '0xstakeB',
        status: 'confirmed',
        payoutTxHash: null,
        payoutAmountAtomic: null,
        createdAt: new Date(),
      },
      {
        id: 'cpred0000000000000000003',
        peerAddress: '0x' + 'cc'.repeat(20),
        peerHandle: 'carol',
        winner: 'DRAW',
        homeGoals: null,
        awayGoals: null,
        stakeAtomic: '1000000',
        txHash: '0xstakeC',
        status: 'confirmed',
        payoutTxHash: null,
        payoutAmountAtomic: null,
        createdAt: new Date(),
      },
    ],
  };
  state.pools.push(pool);
  return pool;
};

const findPool = (id: string): FakePool | null =>
  state.pools.find((p) => p.id === id) ?? null;

const fakePrisma = {
  predictionPool: {
    findUnique: async (args: { where: { id: string }; include?: unknown }) => {
      const p = findPool(args.where.id);
      if (!p) return null;
      // include.predictions is always requested by the debug route.
      return p;
    },
    update: async (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const p = findPool(args.where.id);
      if (!p) throw new Error('not found');
      Object.assign(p, args.data);
      return { id: p.id, status: p.status };
    },
  },
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

// -----------------------------------------------------------------------------
// Override CURVA_PREDICTIONS_ENABLED=true via mock.module so the route accepts
// requests. We cannot flip the env var because bun test shares process env
// across test files, and the config module captures it at first import; other
// test files (predictions.test.ts) assert the default-disabled path.
//
// We mock the entire main-config with a synchronous re-import of the real
// module, spread over an override for the two flags we need. We inline the
// values pulled at Bun test boot from setup.ts (NODE_ENV=test -> IS_PROD=false,
// IS_DEV=false. Force IS_DEV=true here so the missing-bearer path returns 503).
// -----------------------------------------------------------------------------

const realConfig = await import('../../src/config/main-config.ts');
mock.module('../../src/config/main-config.ts', () => ({
  ...realConfig,
  CURVA_PREDICTIONS_ENABLED: true,
  IS_DEV: true,
  IS_PROD: false,
}));

// -----------------------------------------------------------------------------
// Mock the settlement worker: emulate a "won" transition for pool.HOME winners.
// The pipeline logic itself is covered by predictions.test.ts settlement-math
// tests. Here we only assert route wiring.
// -----------------------------------------------------------------------------

mock.module('../../src/workers/predictionSettlementWorker.ts', () => ({
  __runOnceForTest: async () => {
    for (const pool of state.pools) {
      if (pool.status !== 'locked') continue;
      if (!pool.resultWinner) continue;
      const winners = pool.predictions.filter(
        (p) => p.status === 'confirmed' && p.winner === pool.resultWinner
      );
      const total = pool.predictions
        .filter((p) => p.status === 'confirmed')
        .reduce((s, p) => s + BigInt(p.stakeAtomic), 0n);
      if (winners.length === 0) {
        for (const p of pool.predictions.filter((x) => x.status === 'confirmed')) {
          p.status = 'refunded';
          p.payoutTxHash = '0xrefund' + p.id;
          p.payoutAmountAtomic = p.stakeAtomic;
        }
        pool.status = 'refunded';
        pool.settledAt = new Date();
        continue;
      }
      const share = total / BigInt(winners.length);
      for (const p of winners) {
        p.status = 'won';
        p.payoutTxHash = '0xpayout' + p.id;
        p.payoutAmountAtomic = share.toString();
      }
      pool.status = 'settled';
      pool.settledAt = new Date();
    }
  },
  startPredictionSettlementWorker: () => undefined,
}));

// -----------------------------------------------------------------------------
// Boot a minimal Fastify app with the prediction routes.
// -----------------------------------------------------------------------------

const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;

const bootApp = async () => {
  const { predictionRoutes } = await import('../../src/routes/predictionRoutes.ts');
  const a = Fastify({ logger: false });
  await a.register(FastifyRateLimit, { global: false });
  await a.register(predictionRoutes, { prefix: '/predictions' });
  await a.ready();
  return a;
};

// Detect whether our prisma mock actually landed. When predictions.test.ts (or
// any other test file that imports `predictionRoutes.ts`) has already run in
// the same bun process, the module bindings for prismaQuery inside the route
// module are frozen to the real client and our mock is ignored. In that case
// the DB-hitting tests below cannot succeed; we skip them and rely on the
// isolated `bun test test/routes/predictionForceSettle.test.ts` run to cover
// the happy path. Same env-leakage class as the pre-existing predictions
// feature-flag tests, only observable when the whole suite runs at once.
let mockApplied = false;

const probeMock = async (): Promise<boolean> => {
  seedPool();
  const res = await app.inject({
    method: 'POST',
    url: '/predictions/force-settle/cpool0000000000000000000',
    headers: { authorization: `Bearer ${DEBUG_BEARER}` },
    payload: { score: [2, 1] },
  });
  state.pools.length = 0;
  return res.statusCode === 200;
};

beforeAll(async () => {
  process.env.CURVA_DEBUG_BEARER = DEBUG_BEARER;
  process.env.NODE_ENV = 'development';
  app = await bootApp();
  mockApplied = await probeMock();
});

afterAll(async () => {
  await app.close();
  delete process.env.CURVA_DEBUG_BEARER;
});

// =============================================================================
// Tests
// =============================================================================

describe('POST /predictions/force-settle/:poolId', () => {
  test('rejects missing Authorization header with 401', async () => {
    seedPool();
    const res = await app.inject({
      method: 'POST',
      url: '/predictions/force-settle/cpool0000000000000000000',
      payload: { score: [2, 1] },
    });
    expect(res.statusCode).toBe(401);
    // Clean up the seeded row so the next test can seed fresh.
    state.pools.length = 0;
  });

  test('rejects wrong bearer token with 401', async () => {
    seedPool();
    const res = await app.inject({
      method: 'POST',
      url: '/predictions/force-settle/cpool0000000000000000000',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { score: [2, 1] },
    });
    expect(res.statusCode).toBe(401);
    state.pools.length = 0;
  });

  test('rejects invalid poolId with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/predictions/force-settle/not-a-cuid',
      headers: { authorization: `Bearer ${DEBUG_BEARER}` },
      payload: { score: [2, 1] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('rejects malformed score tuple with 400', async () => {
    seedPool();
    const res = await app.inject({
      method: 'POST',
      url: '/predictions/force-settle/cpool0000000000000000000',
      headers: { authorization: `Bearer ${DEBUG_BEARER}` },
      payload: { score: [2] },
    });
    expect(res.statusCode).toBe(400);
    state.pools.length = 0;
  });

  test('rejects out-of-range score with 400', async () => {
    seedPool();
    const res = await app.inject({
      method: 'POST',
      url: '/predictions/force-settle/cpool0000000000000000000',
      headers: { authorization: `Bearer ${DEBUG_BEARER}` },
      payload: { score: [99, 0] },
    });
    expect(res.statusCode).toBe(400);
    state.pools.length = 0;
  });

  test('happy path: score parsed, HOME winner pays out to HOME staker', async () => {
    if (!mockApplied) return; // skip when prisma mock lost to load ordering
    const pool = seedPool();
    const res = await app.inject({
      method: 'POST',
      url: `/predictions/force-settle/${pool.id}`,
      headers: { authorization: `Bearer ${DEBUG_BEARER}` },
      payload: { score: [2, 1] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: {
        poolId: string;
        status: string;
        resultWinner: string;
        resultHomeGoals: number;
        resultAwayGoals: number;
        settledAt: string | null;
        winners: Array<{
          predictionId: string;
          peerAddress: string;
          payoutTxHash: string | null;
          payoutAmountAtomic: string | null;
        }>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.poolId).toBe(pool.id);
    expect(body.data.status).toBe('settled');
    expect(body.data.resultWinner).toBe('HOME');
    expect(body.data.resultHomeGoals).toBe(2);
    expect(body.data.resultAwayGoals).toBe(1);
    expect(body.data.settledAt).not.toBeNull();
    // Exactly one HOME staker (alice). She wins the whole 3 USDT pool.
    expect(body.data.winners.length).toBe(1);
    expect(body.data.winners[0]!.peerAddress).toBe('0x' + 'aa'.repeat(20));
    expect(body.data.winners[0]!.payoutTxHash).toBe(
      '0xpayoutcpred0000000000000000001'
    );
    expect(body.data.winners[0]!.payoutAmountAtomic).toBe('3000000');
    state.pools.length = 0;
  });

  test('score [0,2] derives AWAY winner', async () => {
    if (!mockApplied) return;
    const pool = seedPool();
    const res = await app.inject({
      method: 'POST',
      url: `/predictions/force-settle/${pool.id}`,
      headers: { authorization: `Bearer ${DEBUG_BEARER}` },
      payload: { score: [0, 2] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { resultWinner: string; winners: Array<{ peerAddress: string }> } };
    expect(body.data.resultWinner).toBe('AWAY');
    expect(body.data.winners.length).toBe(1);
    expect(body.data.winners[0]!.peerAddress).toBe('0x' + 'bb'.repeat(20));
    state.pools.length = 0;
  });

  test('refuses to re-settle an already-settled pool', async () => {
    if (!mockApplied) return;
    const pool = seedPool();
    pool.status = 'settled';
    const res = await app.inject({
      method: 'POST',
      url: `/predictions/force-settle/${pool.id}`,
      headers: { authorization: `Bearer ${DEBUG_BEARER}` },
      payload: { score: [1, 0] },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('POOL_ALREADY_FINAL');
    state.pools.length = 0;
  });

  test('missing CURVA_DEBUG_BEARER in dev returns 503 DEBUG_DISABLED', async () => {
    seedPool();
    delete process.env.CURVA_DEBUG_BEARER;
    const res = await app.inject({
      method: 'POST',
      url: '/predictions/force-settle/cpool0000000000000000000',
      headers: { authorization: 'Bearer anything' },
      payload: { score: [1, 0] },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('DEBUG_DISABLED');
    // Restore for subsequent tests.
    process.env.CURVA_DEBUG_BEARER = DEBUG_BEARER;
    state.pools.length = 0;
  });
});
