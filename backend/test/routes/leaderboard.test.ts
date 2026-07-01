/**
 * F3 route tests for /leaderboard. Mocks Prisma's findUnique + $queryRaw.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

const roomRows = new Map<string, { id: string; hostHandle: string; deletedAt: Date | null }>();
roomRows.set('curva-sud-torino', { id: 'r1', hostHandle: 'Curva Sud', deletedAt: null });
roomRows.set('soft-deleted', { id: 'r2', hostHandle: 'Gone', deletedAt: new Date() });

interface FakeTipRow {
  from_address: string;
  to_address: string;
  amount: bigint;
  room_id: string;
  is_demo: boolean;
}

const tips: FakeTipRow[] = [
  // Self-tip: should be excluded.
  { from_address: '0xself', to_address: '0xself', amount: 999_000_000n, room_id: 'r1', is_demo: false },
  { from_address: '0xaaaa', to_address: '0xhost', amount: 5_000_000n, room_id: 'r1', is_demo: false },
  { from_address: '0xbbbb', to_address: '0xhost', amount: 1_000_000n, room_id: 'r1', is_demo: false },
  { from_address: '0xaaaa', to_address: '0xhost', amount: 2_000_000n, room_id: 'r1', is_demo: false },
  // Demo tips: MUST be excluded from the leaderboard (W2-HIGH-03).
  { from_address: '0xdemo1', to_address: '0xhost', amount: 50_000_000n, room_id: 'r1', is_demo: true },
  { from_address: '0xdemo2', to_address: '0xhost', amount: 50_000_000n, room_id: 'r1', is_demo: true },
  { from_address: '0xdemo3', to_address: '0xhost', amount: 50_000_000n, room_id: 'r1', is_demo: true },
];

const fakePrisma = {
  room: {
    findUnique: async (args: { where: { slug: string }; select?: unknown }) => {
      const r = roomRows.get(args.where.slug);
      if (!r) return null;
      return { id: r.id, hostHandle: r.hostHandle, deletedAt: r.deletedAt };
    },
  },
  match: {
    findUnique: async (args: { where: { id: string } }) =>
      args.where.id === 'c' + 'a'.repeat(24) ? { id: args.where.id } : null,
  },
  $queryRaw: async (sql: { strings?: ReadonlyArray<string>; values?: unknown[] } | unknown) => {
    // Heuristic: inspect the joined SQL to route to the right canned result.
    // This is sufficient because the production code uses Prisma.sql tagged templates.
    const joined = ((sql as { strings?: ReadonlyArray<string> }).strings || []).join(' ');
    if (joined.includes('FROM tip_events te') && joined.includes('te.room_id =')) {
      // per-room: group by from_address, exclude self-tips, exclude demo rows
      const inRoom = tips.filter(
        (t) => t.room_id === 'r1' && t.from_address !== t.to_address && !t.is_demo
      );
      const byFrom = new Map<string, { count: number; sum: bigint }>();
      for (const t of inRoom) {
        const prev = byFrom.get(t.from_address) ?? { count: 0, sum: 0n };
        byFrom.set(t.from_address, { count: prev.count + 1, sum: prev.sum + t.amount });
      }
      return Array.from(byFrom.entries())
        .sort((a, b) => Number(b[1].sum - a[1].sum))
        .map(([from, agg]) => ({
          from_address: from,
          tip_count: agg.count,
          total_amount: agg.sum.toString(),
        }));
    }
    if (joined.includes('SELECT te.to_address')) {
      // global recipients (exclude self-tips + demo)
      const filtered = tips.filter((t) => t.from_address !== t.to_address && !t.is_demo);
      const byTo = new Map<string, { count: number; sum: bigint }>();
      for (const t of filtered) {
        const prev = byTo.get(t.to_address) ?? { count: 0, sum: 0n };
        byTo.set(t.to_address, { count: prev.count + 1, sum: prev.sum + t.amount });
      }
      return Array.from(byTo.entries()).map(([to, agg]) => ({
        to_address: to,
        tip_count: agg.count,
        total_amount: agg.sum.toString(),
        host_handle: 'Some Host',
      }));
    }
    if (joined.includes('SELECT te.from_address')) {
      // global tippers (exclude self-tips + demo)
      const filtered = tips.filter((t) => t.from_address !== t.to_address && !t.is_demo);
      const byFrom = new Map<string, { count: number; sum: bigint }>();
      for (const t of filtered) {
        const prev = byFrom.get(t.from_address) ?? { count: 0, sum: 0n };
        byFrom.set(t.from_address, { count: prev.count + 1, sum: prev.sum + t.amount });
      }
      return Array.from(byFrom.entries()).map(([from, agg]) => ({
        from_address: from,
        tip_count: agg.count,
        total_amount: agg.sum.toString(),
      }));
    }
    if (joined.includes('FROM rooms r')) {
      return [];
    }
    return [];
  },
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

// F10: the leaderboard now uses a route-local TtlCache (capacity 500) keyed by
// chain scope. Tests reset it between cases via the exported helper.
const { leaderboardRoutes, __resetLeaderboardCacheForTest } = await import(
  '../../src/routes/leaderboardRoutes.ts'
);
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(leaderboardRoutes, { prefix: '/leaderboard' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  __resetLeaderboardCacheForTest();
});

describe('GET /leaderboard/:slug', () => {
  test('returns top tippers excluding self-tips, ordered DESC', async () => {
    __resetLeaderboardCacheForTest();
    const res = await app.inject({ method: 'GET', url: '/leaderboard/curva-sud-torino' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { topTippers: Array<{ fromAddress: string; totalAmount: string; tipCount: number }> };
    };
    expect(body.data.topTippers.length).toBe(2);
    // 0xaaaa should beat 0xbbbb on total (5+2 > 1) and self-tip should be absent.
    expect(body.data.topTippers[0]!.totalAmount).toBe('7000000');
    expect(body.data.topTippers[0]!.tipCount).toBe(2);
    for (const row of body.data.topTippers) {
      expect(row.fromAddress).not.toContain('0xself');
      // W2-HIGH-03: demo-only tippers must not surface in the leaderboard.
      expect(row.fromAddress).not.toContain('0xdemo');
    }
  });

  test('404 on unknown slug', async () => {
    __resetLeaderboardCacheForTest();
    const res = await app.inject({ method: 'GET', url: '/leaderboard/no-such-slug' });
    expect(res.statusCode).toBe(404);
  });

  test('400 on invalid slug', async () => {
    __resetLeaderboardCacheForTest();
    const res = await app.inject({ method: 'GET', url: '/leaderboard/BAD SLUG' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /leaderboard/global', () => {
  test('returns recipients + tippers', async () => {
    __resetLeaderboardCacheForTest();
    const res = await app.inject({ method: 'GET', url: '/leaderboard/global' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { topRecipients: unknown[]; topTippers: unknown[] };
    };
    expect(Array.isArray(body.data.topRecipients)).toBe(true);
    expect(Array.isArray(body.data.topTippers)).toBe(true);
  });
});

// F10: ?chainId= filter on leaderboard endpoints.
describe('GET /leaderboard/* ?chainId=', () => {
  test('accepts a known enabled chainId on /global', async () => {
    __resetLeaderboardCacheForTest();
    const res = await app.inject({
      method: 'GET',
      url: '/leaderboard/global?chainId=11155111',
    });
    expect(res.statusCode).toBe(200);
  });

  test('400 on unknown chainId for /global', async () => {
    __resetLeaderboardCacheForTest();
    const res = await app.inject({
      method: 'GET',
      url: '/leaderboard/global?chainId=42',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('CHAIN_UNSUPPORTED');
  });

  test('200 with meta.warning CHAIN_DISABLED on disabled chainId for /global', async () => {
    __resetLeaderboardCacheForTest();
    // 9746 (Plasma) is configured but disabled by default in chains.json.
    // ADR-009 + W3 remediation: known-but-disabled chains return 200 with an
    // empty result and `meta.warning: 'CHAIN_DISABLED'`.
    const res = await app.inject({
      method: 'GET',
      url: '/leaderboard/global?chainId=9746',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { meta?: { warning: string } } };
    expect(body.data.meta?.warning).toBe('CHAIN_DISABLED');
  });

  test('400 on garbage chainId', async () => {
    __resetLeaderboardCacheForTest();
    const res = await app.inject({
      method: 'GET',
      url: '/leaderboard/global?chainId=not-a-number',
    });
    expect(res.statusCode).toBe(400);
  });

  test('400 on chainId for /:slug endpoint', async () => {
    __resetLeaderboardCacheForTest();
    const res = await app.inject({
      method: 'GET',
      url: '/leaderboard/curva-sud-torino?chainId=99999',
    });
    expect(res.statusCode).toBe(400);
  });
});
