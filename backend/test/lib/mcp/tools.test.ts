/**
 * F14 MCP tools unit tests.
 *
 * Each tool is called with valid + invalid args. We stub prisma so no live DB
 * roundtrip is required.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

// -----------------------------------------------------------------------------
// Stub prisma before importing tool module.
// -----------------------------------------------------------------------------

interface FakeRoom {
  id: string;
  slug: string;
  hostHandle: string;
  hostSmartAddress: string;
  matchId: string;
  createdAt: Date;
  expiresAt: Date;
  isAutoWarmed: boolean;
  deletedAt: Date | null;
  match?: unknown;
}
interface FakeTip {
  id: string;
  chainId: number;
  fromAddress: string;
  toAddress: string;
  amount: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: Date;
  roomId: string | null;
}

const rooms: FakeRoom[] = [
  {
    id: 'room1',
    slug: 'curva-nord',
    hostHandle: 'nord-host',
    hostSmartAddress: '0x' + '11'.repeat(20),
    matchId: 'clabcdefghij1234567890abcd',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    isAutoWarmed: false,
    deletedAt: null,
    match: {
      id: 'clabcdefghij1234567890abcd',
      kickoffUtc: new Date('2026-06-30T18:00:00Z'),
      stage: 'group',
      status: 'scheduled',
      homeTeam: { code: 'ITA', name: 'Italy' },
      awayTeam: { code: 'ARG', name: 'Argentina' },
    },
  },
];

const tips: FakeTip[] = [];

const fakePrisma = {
  room: {
    findMany: async (args: { where?: Record<string, unknown>; take?: number; include?: unknown; orderBy?: unknown }) => {
      let list = rooms.slice();
      if (args.where?.matchId) {
        list = list.filter((r) => r.matchId === args.where!.matchId);
      }
      if (args.where?.deletedAt === null) {
        list = list.filter((r) => r.deletedAt === null);
      }
      return list.slice(0, args.take ?? list.length);
    },
    findUnique: async (args: { where: { slug?: string; id?: string } }) => {
      if (args.where.slug) return rooms.find((r) => r.slug === args.where.slug) ?? null;
      if (args.where.id) return rooms.find((r) => r.id === args.where.id) ?? null;
      return null;
    },
  },
  match: {
    findUnique: async (args: { where: { id?: string; externalId?: number } }) => {
      if (args.where.id === 'clabcdefghij1234567890abcd') {
        return {
          id: 'clabcdefghij1234567890abcd',
          externalId: 12345,
          status: 'scheduled',
          homeScore: 0,
          awayScore: 0,
          currentMinute: null,
          lastSyncedAt: null,
        };
      }
      return null;
    },
  },
  tipEvent: {
    findMany: async (args: { where?: Record<string, unknown>; take?: number; orderBy?: unknown }) => {
      let list = tips.slice();
      if (args.where?.roomId) {
        list = list.filter((t) => t.roomId === args.where!.roomId);
      }
      return list.slice(0, args.take ?? list.length);
    },
  },
  errorLog: { create: async () => ({}) },
  $queryRaw: async () => [],
};

mock.module('../../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

// -----------------------------------------------------------------------------
// Import tools AFTER mock is registered.
// -----------------------------------------------------------------------------

const toolsModule = await import('../../../src/lib/mcp/tools.ts');
const { __toolsForTest } = toolsModule;
const CTX: import('../../../src/lib/mcp/server.ts').McpContext = {
  lang: 'en',
  ip: '127.0.0.1',
};

beforeAll(() => {
  /* nothing */
});

afterAll(() => {
  rooms.length = 1; // keep initial seed
});

describe('list_rooms', () => {
  test('returns rooms with masked host handle', async () => {
    const res = await __toolsForTest.listRoomsTool.handler({}, CTX);
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as {
      rooms: Array<{ slug: string; hostHandle: string; homeTeam: string | null }>;
    };
    expect(data.rooms.length).toBeGreaterThan(0);
    expect(data.rooms[0]?.slug).toBe('curva-nord');
    // Handle is masked (nor***).
    expect(data.rooms[0]?.hostHandle.endsWith('***')).toBe(true);
    expect(data.rooms[0]?.homeTeam).toBe('Italy');
  });

  test('rejects invalid matchId', async () => {
    const res = await __toolsForTest.listRoomsTool.handler(
      { matchId: 'not-a-cuid' },
      CTX
    );
    expect(res.isError).toBe(true);
  });
});

describe('get_match_live', () => {
  test('returns match snapshot for a valid CUID', async () => {
    const res = await __toolsForTest.getMatchLiveTool.handler(
      { matchId: 'clabcdefghij1234567890abcd' },
      CTX
    );
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as {
      matchId: string;
      statusLabel: string;
      goals: unknown[];
    };
    expect(data.matchId).toBe('clabcdefghij1234567890abcd');
    expect(typeof data.statusLabel).toBe('string');
    expect(Array.isArray(data.goals)).toBe(true);
  });

  test('rejects missing matchId', async () => {
    const res = await __toolsForTest.getMatchLiveTool.handler({}, CTX);
    expect(res.isError).toBe(true);
  });

  test('returns error for unknown matchId', async () => {
    const res = await __toolsForTest.getMatchLiveTool.handler(
      { matchId: 'clNOPENOPENOPENOPENOPENOPEN' },
      CTX
    );
    expect(res.isError).toBe(true);
  });
});

describe('get_leaderboard', () => {
  test('global scope returns top recipients + tippers arrays', async () => {
    const res = await __toolsForTest.getLeaderboardTool.handler(
      { scope: 'global' },
      CTX
    );
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as {
      topRecipients: unknown[];
      topTippers: unknown[];
    };
    expect(Array.isArray(data.topRecipients)).toBe(true);
    expect(Array.isArray(data.topTippers)).toBe(true);
  });

  test('room scope requires a valid identifier', async () => {
    const res = await __toolsForTest.getLeaderboardTool.handler(
      { scope: 'room', identifier: 'not_a_slug' },
      CTX
    );
    expect(res.isError).toBe(true);
  });

  test('unknown scope returns error', async () => {
    const res = await __toolsForTest.getLeaderboardTool.handler(
      { scope: 'bogus' },
      CTX
    );
    expect(res.isError).toBe(true);
  });
});

describe('get_room_tips', () => {
  test('returns tips array for a known slug', async () => {
    const res = await __toolsForTest.getRoomTipsTool.handler(
      { slug: 'curva-nord' },
      CTX
    );
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as { slug: string; tips: unknown[] };
    expect(data.slug).toBe('curva-nord');
    expect(Array.isArray(data.tips)).toBe(true);
  });

  test('rejects invalid slug', async () => {
    const res = await __toolsForTest.getRoomTipsTool.handler(
      { slug: '???' },
      CTX
    );
    expect(res.isError).toBe(true);
  });

  test('returns error for unknown slug', async () => {
    const res = await __toolsForTest.getRoomTipsTool.handler(
      { slug: 'unknown-slug' },
      CTX
    );
    expect(res.isError).toBe(true);
  });
});

describe('get_supported_chains', () => {
  test('returns default + chains list', async () => {
    const res = await __toolsForTest.getSupportedChainsTool.handler({}, CTX);
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as {
      defaultChainId: number;
      chains: Array<{ chainId: number; name: string }>;
    };
    expect(typeof data.defaultChainId).toBe('number');
    expect(Array.isArray(data.chains)).toBe(true);
    expect(data.chains.length).toBeGreaterThan(0);
    // Sepolia is the default.
    expect(data.chains.some((c) => c.chainId === 11155111)).toBe(true);
  });
});

describe('list_qvac_models', () => {
  test('returns registry version + models', async () => {
    const res = await __toolsForTest.listQvacModelsTool.handler({}, CTX);
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as {
      version: string;
      models: Array<{ id: string }>;
    };
    expect(typeof data.version).toBe('string');
    expect(Array.isArray(data.models)).toBe(true);
  });

  test('filters by family', async () => {
    const res = await __toolsForTest.listQvacModelsTool.handler(
      { family: 'bergamot' },
      CTX
    );
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as { models: Array<{ family: string }> };
    for (const m of data.models) expect(m.family).toBe('bergamot');
  });
});

describe('prepare_tip (facilitator disabled)', () => {
  test('returns isError when facilitator is disabled', async () => {
    // The test env leaves RELAY_SPONSOR_PK unset -> facilitator disabled.
    const res = await __toolsForTest.prepareTipTool.handler(
      {
        chainId: 11155111,
        hostSlug: 'curva-nord',
        amountBaseUnits: '1000000',
      },
      CTX
    );
    expect(res.isError).toBe(true);
  });
});

describe('get_room (W4 CR-Major#5 remediation)', () => {
  test('returns a single room with masked handle', async () => {
    const res = await __toolsForTest.getRoomTool.handler(
      { slug: 'curva-nord' },
      CTX
    );
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as {
      slug: string;
      hostHandle: string;
      homeTeam: string | null;
    };
    expect(data.slug).toBe('curva-nord');
    expect(data.hostHandle.endsWith('***')).toBe(true);
    expect(data.homeTeam).toBe('Italy');
  });

  test('rejects invalid slug', async () => {
    const res = await __toolsForTest.getRoomTool.handler({ slug: '???' }, CTX);
    expect(res.isError).toBe(true);
  });

  test('returns error for unknown slug', async () => {
    const res = await __toolsForTest.getRoomTool.handler(
      { slug: 'unknown-slug' },
      CTX
    );
    expect(res.isError).toBe(true);
  });
});

describe('list_matches_today (W4 CR-Major#5 remediation)', () => {
  test('returns a matches array + today window bounds', async () => {
    // Stub findMany on match to return an empty list — the stub in fakePrisma
    // doesn't cover this call so extend it inline via mock.module override
    // isn't possible; the tool will fall through to prismaQuery.match.findMany.
    // Since the fake exposes only findUnique on match, we tolerate a runtime
    // error and just assert the tool guards it. Add findMany here to make the
    // test meaningful.
    (fakePrisma.match as unknown as { findMany: () => Promise<unknown[]> }).findMany =
      async () => [];
    const res = await __toolsForTest.listMatchesTodayTool.handler({}, CTX);
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as {
      windowFromUtc: string;
      windowToUtc: string;
      count: number;
      matches: unknown[];
    };
    expect(typeof data.windowFromUtc).toBe('string');
    expect(typeof data.windowToUtc).toBe('string');
    expect(data.count).toBe(0);
    expect(Array.isArray(data.matches)).toBe(true);
  });
});

describe('get_status (W4 CR-Major#5 remediation)', () => {
  test('returns backend health snapshot with db + metrics', async () => {
    // Add $queryRaw for the SELECT 1 ping.
    (fakePrisma as unknown as { $queryRaw: () => Promise<unknown[]> }).$queryRaw =
      async () => [{ '?column?': 1 }];
    // Add count() to the room + tipEvent stubs so get_status's Promise.all
    // resolves. The tool itself catches per-count failures so a missing stub
    // would fall through to 0; adding them here makes the assertion meaningful.
    (fakePrisma.room as unknown as { count: () => Promise<number> }).count =
      async () => 1;
    (fakePrisma.tipEvent as unknown as { count: () => Promise<number> }).count =
      async () => 0;
    const res = await __toolsForTest.getStatusTool.handler({}, CTX);
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as {
      status: string;
      components: { db: { ok: boolean } };
      metrics: { activeRooms: number; totalRooms: number; totalTipsLifetime: number };
    };
    expect(['ok', 'down']).toContain(data.status);
    expect(typeof data.components.db.ok).toBe('boolean');
    expect(typeof data.metrics.activeRooms).toBe('number');
  });
});
