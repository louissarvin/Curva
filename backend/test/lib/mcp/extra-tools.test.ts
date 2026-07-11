/**
 * F14 extra MCP tools unit tests.
 *
 * Covers: get_prediction_pool, get_user_profile, get_h2h_history,
 * get_tournament_bracket. Prisma is stubbed via mock.module so the tools run
 * without a live DB. The WC26 corpus loader falls back to whatever the real
 * on-disk file exposes; the h2h/bracket tests validate shape rather than
 * specific rows so the tests survive corpus updates.
 */

import { describe, expect, mock, test } from 'bun:test';

const rooms: unknown[] = [];
const tips: unknown[] = [];
const preds: unknown[] = [];
const pools: Array<{
  id: string;
  roomSlug: string;
  matchId: string;
  mode: string;
  entryStakeAtomic: string;
  deadlineMs: bigint;
  status: string;
  totalStakedAtomic: string;
  chainId: number;
  createdAt: Date;
}> = [
  {
    id: 'pool1',
    roomSlug: 'curva-nord',
    matchId: 'clabcdefghij1234567890abcd',
    mode: 'winner-only',
    entryStakeAtomic: '1000000',
    deadlineMs: BigInt(Date.now() + 3_600_000),
    status: 'open',
    totalStakedAtomic: '5000000',
    chainId: 11155111,
    createdAt: new Date(),
  },
];

const fakePrisma = {
  room: {
    count: async (_args: unknown) => 0,
    findMany: async () => rooms,
    findUnique: async () => null,
  },
  tipEvent: {
    count: async (_args: unknown) => 0,
    findMany: async () => tips,
  },
  prediction: {
    count: async (_args: unknown) => 0,
    findMany: async () => preds,
  },
  predictionPool: {
    findMany: async (args: { where?: Record<string, unknown>; take?: number }) => {
      let list = pools.slice();
      const w = args.where || {};
      if (w.roomSlug) list = list.filter((p) => p.roomSlug === w.roomSlug);
      if (w.status) list = list.filter((p) => p.status === w.status);
      return list.slice(0, args.take ?? list.length);
    },
  },
  errorLog: { create: async () => ({}) },
  $queryRaw: async () => [],
};

mock.module('../../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

const toolsModule = await import('../../../src/lib/mcp/tools.ts');
const { __toolsForTest } = toolsModule;
const CTX: import('../../../src/lib/mcp/server.ts').McpContext = {
  lang: 'en',
  ip: '127.0.0.1',
};

// -----------------------------------------------------------------------------
// Schema sanity
// -----------------------------------------------------------------------------

describe('extra tool schemas', () => {
  test('get_prediction_pool has valid input schema', () => {
    const s = __toolsForTest.getPredictionPoolTool.inputSchema;
    expect(s.type).toBe('object');
    expect((s.required as string[]).includes('roomSlug')).toBe(true);
  });
  test('get_user_profile has valid input schema', () => {
    const s = __toolsForTest.getUserProfileTool.inputSchema;
    expect(s.type).toBe('object');
    expect((s.required as string[]).includes('ownerAddress')).toBe(true);
  });
  test('get_h2h_history has valid input schema', () => {
    const s = __toolsForTest.getH2hHistoryTool.inputSchema;
    expect(s.type).toBe('object');
    expect((s.required as string[]).includes('teamA')).toBe(true);
    expect((s.required as string[]).includes('teamB')).toBe(true);
  });
  test('get_tournament_bracket has valid input schema', () => {
    const s = __toolsForTest.getTournamentBracketTool.inputSchema;
    expect(s.type).toBe('object');
    expect((s.required as string[]).includes('competition')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// get_prediction_pool
// -----------------------------------------------------------------------------

describe('get_prediction_pool', () => {
  test('returns open pools for a known room slug', async () => {
    const res = await __toolsForTest.getPredictionPoolTool.handler(
      { roomSlug: 'curva-nord' },
      CTX,
    );
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as { pools: unknown[]; count: number };
    expect(Array.isArray(data.pools)).toBe(true);
    expect(data.count).toBe(1);
  });

  test('returns empty array for unknown room slug', async () => {
    const res = await __toolsForTest.getPredictionPoolTool.handler(
      { roomSlug: 'unknown-room-slug' },
      CTX,
    );
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as { pools: unknown[]; count: number };
    expect(data.count).toBe(0);
    expect(data.pools.length).toBe(0);
  });

  test('rejects malformed slug', async () => {
    const res = await __toolsForTest.getPredictionPoolTool.handler(
      { roomSlug: 'A' },
      CTX,
    );
    expect(res.isError).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// get_user_profile
// -----------------------------------------------------------------------------

describe('get_user_profile', () => {
  test('returns zeros for unknown owner address', async () => {
    const res = await __toolsForTest.getUserProfileTool.handler(
      { ownerAddress: '0x' + '00'.repeat(20) },
      CTX,
    );
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as {
      totalTipsSent: number;
      totalTipsReceived: number;
      predictionsWon: number;
      predictionsLost: number;
      roomsCreated: number;
    };
    expect(data.totalTipsSent).toBe(0);
    expect(data.totalTipsReceived).toBe(0);
    expect(data.predictionsWon).toBe(0);
    expect(data.predictionsLost).toBe(0);
    expect(data.roomsCreated).toBe(0);
  });

  test('rejects malformed address', async () => {
    const res = await __toolsForTest.getUserProfileTool.handler(
      { ownerAddress: 'not-an-address' },
      CTX,
    );
    expect(res.isError).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// get_h2h_history
// -----------------------------------------------------------------------------

describe('get_h2h_history', () => {
  test('returns an array (possibly empty) for two valid team codes', async () => {
    const res = await __toolsForTest.getH2hHistoryTool.handler(
      { teamA: 'MEX', teamB: 'CAN' },
      CTX,
    );
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as {
      teamA: string;
      teamB: string;
      matches: unknown[];
      count: number;
    };
    expect(data.teamA).toBe('MEX');
    expect(data.teamB).toBe('CAN');
    expect(Array.isArray(data.matches)).toBe(true);
    expect(data.count).toBeLessThanOrEqual(20);
  });

  test('rejects malformed team code', async () => {
    const res = await __toolsForTest.getH2hHistoryTool.handler(
      { teamA: 'foo', teamB: 'CAN' },
      CTX,
    );
    expect(res.isError).toBe(true);
  });

  test('returns empty when no matches between two unrelated codes', async () => {
    const res = await __toolsForTest.getH2hHistoryTool.handler(
      { teamA: 'ZZZ', teamB: 'YYY' },
      CTX,
    );
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as { matches: unknown[]; count: number };
    expect(data.count).toBe(0);
    expect(data.matches.length).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// get_tournament_bracket
// -----------------------------------------------------------------------------

describe('get_tournament_bracket', () => {
  test('returns bracket structure', async () => {
    const res = await __toolsForTest.getTournamentBracketTool.handler(
      { competition: 'wc2026' },
      CTX,
    );
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as {
      bracket: Record<string, unknown[]>;
      available?: boolean;
    };
    expect(data.bracket).toBeDefined();
    // All five knockout keys are always present in the response shape.
    expect(data.bracket.r16).toBeDefined();
    expect(data.bracket.qf).toBeDefined();
    expect(data.bracket.sf).toBeDefined();
    expect(data.bracket.final).toBeDefined();
    expect(data.bracket.third_place).toBeDefined();
    expect(Array.isArray(data.bracket.r16)).toBe(true);
  });

  test('rejects overlong competition input', async () => {
    const res = await __toolsForTest.getTournamentBracketTool.handler(
      { competition: 'x'.repeat(64) },
      CTX,
    );
    expect(res.isError).toBe(true);
  });
});
