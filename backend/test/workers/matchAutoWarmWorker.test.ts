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
    findMany: async (args: { where: { status: string; kickoffUtc: { gt: Date; lt: Date } } }) => {
      return matches.filter(
        (m) =>
          m.status === args.where.status &&
          m.kickoffUtc.getTime() > args.where.kickoffUtc.gt.getTime() &&
          m.kickoffUtc.getTime() < args.where.kickoffUtc.lt.getTime()
      );
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
  test('creates an auto-room for a match within the lead window', async () => {
    matches.length = 0;
    rooms.length = 0;
    const inFifteen = new Date(nowMs + 15 * 60_000);
    matches.push({ id: 'cmatch1', kickoffUtc: inFifteen, status: 'scheduled' });

    await runAutoWarmTick();

    expect(rooms.length).toBe(1);
    expect(rooms[0]!.slug).toBe('auto-cmatch1');
    expect(rooms[0]!.isAutoWarmed).toBe(true);
  });

  test('is idempotent — re-running does not create duplicates', async () => {
    await runAutoWarmTick();
    expect(rooms.length).toBe(1);
  });

  test('skips matches outside the lead window', async () => {
    matches.length = 0;
    rooms.length = 0;
    const inTwoHours = new Date(nowMs + 2 * 60 * 60_000);
    matches.push({ id: 'cmatchfar', kickoffUtc: inTwoHours, status: 'scheduled' });

    await runAutoWarmTick();
    expect(rooms.length).toBe(0);
  });

  test('soft-deletes auto-rooms whose match window has fully ended', async () => {
    matches.length = 0;
    rooms.length = 0;
    // Place a match kickoff far in the past so the cleanup branch fires.
    const longAgo = new Date(nowMs - 100 * 60 * 60_000);
    matches.push({ id: 'cmatchold', kickoffUtc: longAgo, status: 'scheduled' });
    rooms.push({
      id: 'rid',
      slug: 'auto-cmatchold',
      matchId: 'cmatchold',
      hostSmartAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      isAutoWarmed: true,
      deletedAt: null,
      expiresAt: new Date(nowMs - 60 * 60_000),
    });

    await runAutoWarmTick();

    expect(rooms[0]!.deletedAt).not.toBeNull();
    expect(stopCalls).toContain('auto-cmatchold');
  });
});
