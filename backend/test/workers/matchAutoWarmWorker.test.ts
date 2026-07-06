/**
 * F2 unit tests for matchAutoWarmWorker. We mock Prisma + the seeder
 * supervisor and stub MATCH_AUTO_WARM_* env so the worker is enabled.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

process.env.AUTO_WARM_HOST_OWNER_ADDRESS =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.AUTO_WARM_HOST_SMART_ADDRESS =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

interface FakeMatch {
  id: string;
  kickoffUtc: Date;
  status: 'scheduled' | 'live' | 'finished';
  stage: 'group' | 'r16' | 'qf' | 'sf' | 'third_place' | 'final';
  externalId: number | null;
}

interface FakeRoom {
  id: string;
  slug: string;
  matchId: string;
  hostSmartAddress: string;
  isAutoWarmed: boolean;
  deletedAt: Date | null;
  expiresAt: Date;
  match?: { kickoffUtc: Date };
}

let nowMs = new Date('2026-07-15T12:00:00Z').getTime();
const matches: FakeMatch[] = [];
const rooms: FakeRoom[] = [];

const fakePrisma = {
  match: {
    findMany: async (args: {
      where: {
        status: string;
        stage?: string | { in: string[] };
        kickoffUtc: { gt: Date; lt: Date };
      };
    }) => {
      return matches.filter((m) => {
        if (m.status !== args.where.status) return false;
        if (m.kickoffUtc.getTime() <= args.where.kickoffUtc.gt.getTime()) return false;
        if (m.kickoffUtc.getTime() >= args.where.kickoffUtc.lt.getTime()) return false;
        const stageFilter = args.where.stage;
        if (typeof stageFilter === 'string') {
          if (m.stage !== stageFilter) return false;
        } else if (stageFilter && 'in' in stageFilter) {
          if (!stageFilter.in.includes(m.stage)) return false;
        }
        return true;
      });
    },
  },
  room: {
    findUnique: async (args: { where: { slug: string } }) =>
      rooms.find((r) => r.slug === args.where.slug) ?? null,
    findMany: async (args: { where: { isAutoWarmed: boolean; deletedAt: null }; include?: unknown }) => {
      const filtered = rooms.filter(
        (r) => r.isAutoWarmed === args.where.isAutoWarmed && r.deletedAt === null
      );
      if (args.include) {
        return filtered.map((r) => ({
          ...r,
          match: matches.find((m) => m.id === r.matchId)
            ? { kickoffUtc: matches.find((m) => m.id === r.matchId)!.kickoffUtc }
            : null,
        }));
      }
      return filtered;
    },
    upsert: async (args: {
      where: { slug: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const existing = rooms.find((r) => r.slug === args.where.slug);
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row: FakeRoom = {
        id: 'room-' + args.where.slug,
        slug: args.where.slug,
        matchId: String(args.create.matchId),
        hostSmartAddress: String(args.create.hostSmartAddress),
        isAutoWarmed: Boolean(args.create.isAutoWarmed),
        deletedAt: null,
        expiresAt: args.create.expiresAt as Date,
      };
      rooms.push(row);
      return row;
    },
    update: async (args: { where: { id: string }; data: { deletedAt?: Date } }) => {
      const r = rooms.find((x) => x.id === args.where.id);
      if (!r) throw new Error('not found');
      if (args.data.deletedAt) r.deletedAt = args.data.deletedAt;
      return r;
    },
  },
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

const stopCalls: string[] = [];
const spawnCalls: string[] = [];
mock.module('../../src/lib/pears/seeder.ts', () => ({
  seederSupervisor: {
    isEnabled: () => false,
    spawnRoom: (slug: string) => {
      spawnCalls.push(slug);
      return true;
    },
    stopRoom: (slug: string) => {
      stopCalls.push(slug);
      return true;
    },
    // These are read by other modules (status page, health) that may be
    // imported transitively when running the full test suite.
    getActiveRoomCount: () => 0,
    getTotalPeers: () => 0,
    getTelemetry: () => null,
    getAllSlugs: () => [],
    shutdown: async () => {},
  },
}));

const { runAutoWarmTick, __testHooks } = await import('../../src/workers/matchAutoWarmWorker.ts');

beforeAll(() => {
  __testHooks.now = () => nowMs;
});

afterAll(() => {
  matches.length = 0;
  rooms.length = 0;
});

describe('matchAutoWarmWorker', () => {
  test('creates an auto-room for a group-stage match within the short lead window', async () => {
    matches.length = 0;
    rooms.length = 0;
    const inFifteen = new Date(nowMs + 15 * 60_000);
    matches.push({
      id: 'cmatch1',
      kickoffUtc: inFifteen,
      status: 'scheduled',
      stage: 'group',
      externalId: 100034,
    });

    await runAutoWarmTick();

    expect(rooms.length).toBe(1);
    // Slug derives from slugForMatch. Group stage uses externalId as the tail.
    expect(rooms[0]!.slug).toBe('wc2026-g-100034');
    expect(rooms[0]!.isAutoWarmed).toBe(true);
  });

  test('is idempotent when re-running does not create duplicates', async () => {
    await runAutoWarmTick();
    expect(rooms.length).toBe(1);
  });

  test('skips group-stage matches outside the short lead window', async () => {
    matches.length = 0;
    rooms.length = 0;
    const inTwoHours = new Date(nowMs + 2 * 60 * 60_000);
    matches.push({
      id: 'cmatchfar',
      kickoffUtc: inTwoHours,
      status: 'scheduled',
      stage: 'group',
      externalId: 100050,
    });

    await runAutoWarmTick();
    expect(rooms.length).toBe(0);
  });

  test('F2: warms every knockout fixture in the 24h horizon with slugForMatch slug', async () => {
    matches.length = 0;
    rooms.length = 0;
    // SF1 kicks off in 4h; SF2 kicks off in 8h; final in 20h. All inside 24h.
    matches.push(
      {
        id: 'csf1',
        kickoffUtc: new Date(nowMs + 4 * 3_600_000),
        status: 'scheduled',
        stage: 'sf',
        externalId: 100100,
      },
      {
        id: 'csf2',
        kickoffUtc: new Date(nowMs + 8 * 3_600_000),
        status: 'scheduled',
        stage: 'sf',
        externalId: 100101,
      },
      {
        id: 'cfinal',
        kickoffUtc: new Date(nowMs + 20 * 3_600_000),
        status: 'scheduled',
        stage: 'final',
        externalId: 100103,
      }
    );

    await runAutoWarmTick();

    const slugs = rooms.map((r) => r.slug).sort();
    expect(slugs).toContain('wc2026-sf1');
    expect(slugs).toContain('wc2026-sf2');
    expect(slugs).toContain('wc2026-final');
  });

  test('F2: knockout matches beyond 24h are NOT warmed', async () => {
    matches.length = 0;
    rooms.length = 0;
    matches.push({
      id: 'cfaraway',
      kickoffUtc: new Date(nowMs + 48 * 3_600_000),
      status: 'scheduled',
      stage: 'qf',
      externalId: 100077,
    });

    await runAutoWarmTick();
    expect(rooms.length).toBe(0);
  });

  test('soft-deletes auto-rooms whose match window has fully ended', async () => {
    matches.length = 0;
    rooms.length = 0;
    // Place a match kickoff far in the past so the cleanup branch fires.
    const longAgo = new Date(nowMs - 100 * 60 * 60_000);
    matches.push({
      id: 'cmatchold',
      kickoffUtc: longAgo,
      status: 'scheduled',
      stage: 'group',
      externalId: 100001,
    });
    rooms.push({
      id: 'rid',
      slug: 'wc2026-g-100001',
      matchId: 'cmatchold',
      hostSmartAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      isAutoWarmed: true,
      deletedAt: null,
      expiresAt: new Date(nowMs - 60 * 60_000),
    });

    await runAutoWarmTick();

    expect(rooms[0]!.deletedAt).not.toBeNull();
    expect(stopCalls).toContain('wc2026-g-100001');
  });
});
