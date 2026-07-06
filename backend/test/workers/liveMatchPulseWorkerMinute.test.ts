/**
 * Cup Final: live match minute pulse tests for liveMatchPulseWorker.
 *
 * Asserts the enriched `match.minute` payload the SSE route re-emits as
 * `match.pulse` for the renderer's floating minute badge:
 *   1. Pulse payload includes { matchId, minute, status, injuryTime } when
 *      the fixture is present in the football-data snapshot.
 *   2. When the DB match has no externalId (i.e. not cached in the FD
 *      snapshot) the worker skips enrichment entirely (no minute publish).
 *   3. Status enum values match the football-data.org v4 lookup table
 *      (SCHEDULED, TIMED, IN_PLAY, PAUSED, EXTRA_TIME, PENALTY_SHOOTOUT,
 *      FINISHED). Verified against
 *      https://docs.football-data.org/general/v4/lookup_tables.html on
 *      2026-07-06.
 *
 * Isolation follows the same pattern as liveMatchPulseWorker.test.ts:
 * fake prisma via mock.module, real eventBus subscription (not mocked),
 * reset in beforeEach/afterEach. See project memory
 * feedback_test_module_mocks + feedback_singleton_buffer_isolation.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.FOOTBALL_DATA_API_KEY = 'test-key';
process.env.FOOTBALL_DATA_API_TIER = 'free';
process.env.LIVE_MATCH_PULSE_WINDOW_BEFORE_MIN = '5';
process.env.LIVE_MATCH_PULSE_WINDOW_AFTER_MIN = '140';
process.env.LIVE_MATCH_PULSE_MATCHES_PER_TICK = '10';

// =============================================================================
// Fake prisma (identical shape to liveMatchPulseWorker.test.ts)
// =============================================================================

interface FakeDbMatch {
  id: string;
  externalId: number | null;
  status: 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled';
  kickoffUtc: Date;
  homeScore: number | null;
  awayScore: number | null;
  currentMinute?: number | null;
  lastSyncedAt?: Date | null;
  homeTeam: { name: string };
  awayTeam: { name: string };
}

const dbMatches: FakeDbMatch[] = [];
const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

const fakePrisma = {
  match: {
    findMany: async (args: {
      where: {
        status: { notIn: string[] };
        kickoffUtc: { gte: Date; lte: Date };
      };
      take?: number;
      orderBy?: unknown;
      include?: unknown;
    }) => {
      const filtered = dbMatches.filter(
        (m) =>
          !args.where.status.notIn.includes(m.status) &&
          m.kickoffUtc.getTime() >= args.where.kickoffUtc.gte.getTime() &&
          m.kickoffUtc.getTime() <= args.where.kickoffUtc.lte.getTime()
      );
      return filtered.slice(0, args.take ?? filtered.length);
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      updates.push({ id: args.where.id, data: args.data });
      const row = dbMatches.find((m) => m.id === args.where.id);
      if (row) Object.assign(row, args.data);
      return row;
    },
  },
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

// =============================================================================
// Real eventBus subscription (per project memory: do NOT mock the module).
// =============================================================================

import { eventBus } from '../../src/lib/activity/eventBus.ts';

interface PublishedEvent {
  type: string;
  payload: Record<string, unknown>;
}
const publishedEvents: PublishedEvent[] = [];
let unsubscribe: (() => void) | null = null;

// =============================================================================
// Fake football-data client
// =============================================================================

import { FootballDataClient } from '../../src/lib/integrations/footballData.ts';

let fdMatchesQueue: unknown[][] = [];
const clientCalls: string[] = [];

const fakeClient = {
  isEnabled: () => true,
  tier: 'free' as const,
  listCompetitionMatches: async (opts: {
    competitionCode: string;
    dateFrom: string;
    dateTo: string;
  }) => {
    clientCalls.push(`list:${opts.competitionCode}`);
    if (fdMatchesQueue.length === 0) return [];
    return fdMatchesQueue.shift() ?? [];
  },
  getMatch: async () => null,
};

let runLiveMatchPulseTick: () => Promise<void>;
let __testHooks: {
  now: () => number;
  setClient: (c: FootballDataClient | null) => void;
  resetState: () => void;
  clearResponseCache: () => void;
};

beforeAll(async () => {
  const mod = await import('../../src/workers/liveMatchPulseWorker.ts');
  runLiveMatchPulseTick = mod.runLiveMatchPulseTick;
  __testHooks = mod.__testHooks;
  __testHooks.setClient(fakeClient as unknown as FootballDataClient);

  unsubscribe = eventBus.subscribe(
    (ev) => {
      publishedEvents.push({ type: ev.type, payload: ev.payload as Record<string, unknown> });
    },
    { topics: new Set(['matches']) }
  );
});

const NOW = new Date('2026-06-15T19:25:00.000Z').getTime();

beforeEach(() => {
  dbMatches.length = 0;
  updates.length = 0;
  publishedEvents.length = 0;
  fdMatchesQueue = [];
  clientCalls.length = 0;
  __testHooks.resetState();
  __testHooks.now = () => NOW;
  __testHooks.setClient(fakeClient as unknown as FootballDataClient);
});

afterEach(() => {
  __testHooks.resetState();
});

afterAll(() => {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  eventBus.__resetForTest();
});

// =============================================================================
// Helpers
// =============================================================================

const seedMatch = (overrides: Partial<FakeDbMatch> = {}): FakeDbMatch => {
  const m: FakeDbMatch = {
    id: 'cmatch1',
    externalId: 12345,
    status: 'live',
    kickoffUtc: new Date(NOW - 10 * 60_000),
    homeScore: 0,
    awayScore: 0,
    homeTeam: { name: 'Argentina' },
    awayTeam: { name: 'Brazil' },
    ...overrides,
  };
  dbMatches.push(m);
  return m;
};

interface FakeFdMatch {
  id: number;
  status: string;
  utcDate: string;
  minute?: number;
  injuryTime?: number | null;
  homeTeam: { id: number; name: string };
  awayTeam: { id: number; name: string };
  score: { fullTime: { home: number | null; away: number | null } };
}

const queueFd = (matches: FakeFdMatch[]): void => {
  fdMatchesQueue.push(matches);
};

const mkFdMatch = (overrides: Partial<FakeFdMatch> = {}): FakeFdMatch => ({
  id: 12345,
  status: 'IN_PLAY',
  utcDate: '2026-06-15T19:00:00Z',
  minute: 34,
  homeTeam: { id: 1, name: 'Argentina' },
  awayTeam: { id: 2, name: 'Brazil' },
  score: { fullTime: { home: 0, away: 0 } },
  ...overrides,
});

const minuteEvents = (): PublishedEvent[] =>
  publishedEvents.filter((e) => e.type === 'match.minute');

// =============================================================================
// Tests
// =============================================================================

describe('liveMatchPulseWorker: match.minute pulse enrichment (Cup Final)', () => {
  test('publishes match.minute with matchId + minute + status + injuryTime when fixture is cached', async () => {
    seedMatch({ status: 'live' });
    queueFd([mkFdMatch({ status: 'IN_PLAY', minute: 34, injuryTime: null })]);
    await runLiveMatchPulseTick();

    const pulses = minuteEvents();
    expect(pulses.length).toBe(1);
    const p = pulses[0]!.payload as {
      matchId: string;
      minute: number | null;
      status: string;
      injuryTime: number | null;
    };
    expect(p.matchId).toBe('cmatch1');
    expect(p.minute).toBe(34);
    expect(p.status).toBe('IN_PLAY');
    expect(p.injuryTime).toBeNull();
  });

  test('carries injuryTime through when upstream populates it (45+3)', async () => {
    seedMatch({ status: 'live' });
    queueFd([mkFdMatch({ status: 'IN_PLAY', minute: 45, injuryTime: 3 })]);
    await runLiveMatchPulseTick();

    const pulses = minuteEvents();
    expect(pulses.length).toBe(1);
    expect(pulses[0]!.payload.minute).toBe(45);
    expect(pulses[0]!.payload.injuryTime).toBe(3);
  });

  test('bounds-checks a hostile injuryTime (999) down to null', async () => {
    seedMatch({ status: 'live' });
    queueFd([mkFdMatch({ status: 'IN_PLAY', minute: 90, injuryTime: 999 })]);
    await runLiveMatchPulseTick();

    const pulses = minuteEvents();
    expect(pulses.length).toBe(1);
    expect(pulses[0]!.payload.injuryTime).toBeNull();
  });

  test('skips enrichment when the DB fixture has no externalId (nothing to enrich)', async () => {
    seedMatch({ externalId: null });
    // Queue is populated but the worker cannot match externalId -> FD row.
    queueFd([mkFdMatch({ status: 'IN_PLAY' })]);
    await runLiveMatchPulseTick();

    expect(minuteEvents().length).toBe(0);
    // Nothing was written to the DB either — the missing-externalId branch
    // returns before processMatch is reached.
    expect(updates.length).toBe(0);
  });

  test('skips enrichment when the fixture is not in the FD snapshot (worker did not fetch it)', async () => {
    seedMatch({ externalId: 99999 }); // valid externalId but absent from FD
    queueFd([mkFdMatch({ id: 12345 })]); // returns a different id
    await runLiveMatchPulseTick();

    // No FD row matched -> processMatch never ran -> no minute pulse.
    expect(minuteEvents().length).toBe(0);
  });

  test('status enum values line up with football-data.org v4 lookup table', async () => {
    // The v4 lookup_tables.html enumerates:
    //   SCHEDULED, TIMED, IN_PLAY, PAUSED, EXTRA_TIME, PENALTY_SHOOTOUT,
    //   FINISHED, SUSPENDED, POSTPONED, CANCELLED, AWARDED.
    // The renderer badge only cares about the live/paused/extra/pso/finished
    // subset — verify each round-trips through the pulse payload untouched.
    const casesUnderTest: Array<{ fd: string; minute?: number }> = [
      { fd: 'IN_PLAY', minute: 34 },
      { fd: 'PAUSED', minute: 45 },
      { fd: 'EXTRA_TIME', minute: 105 },
      { fd: 'PENALTY_SHOOTOUT', minute: 120 },
      { fd: 'FINISHED', minute: 90 },
    ];
    for (const c of casesUnderTest) {
      publishedEvents.length = 0;
      __testHooks.resetState();
      __testHooks.clearResponseCache();
      dbMatches.length = 0;
      seedMatch({ status: 'live' });
      queueFd([
        mkFdMatch({
          status: c.fd,
          minute: c.minute,
          score: { fullTime: { home: 0, away: 0 } },
        }),
      ]);
      await runLiveMatchPulseTick();
      const pulses = minuteEvents();
      expect(pulses.length).toBe(1);
      expect(pulses[0]!.payload.status).toBe(c.fd);
      expect(pulses[0]!.payload.minute).toBe(c.minute ?? null);
    }
  });
});
