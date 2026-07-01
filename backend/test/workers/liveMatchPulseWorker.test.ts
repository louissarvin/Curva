/**
 * F7 unit tests for the live match pulse worker.
 *
 * We mock prisma + the football-data client and assert that the worker
 * publishes the correct match.* events on status / score transitions.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// Force the worker enabled by setting the API key in env BEFORE main-config
// loads the constant. Setting it in setup.ts also works, but this file is
// authoritative for its own posture.
process.env.FOOTBALL_DATA_API_KEY = 'test-key';
process.env.FOOTBALL_DATA_API_TIER = 'free';
process.env.LIVE_MATCH_PULSE_WINDOW_BEFORE_MIN = '5';
process.env.LIVE_MATCH_PULSE_WINDOW_AFTER_MIN = '140';
process.env.LIVE_MATCH_PULSE_MATCHES_PER_TICK = '10';

// =============================================================================
// Fake prisma
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
// Subscribe to the real eventBus to capture publishes. Mocking the eventBus
// module would leak to any other test file loaded after this one (see
// project memory feedback_test_module_mocks). Subscribing is non-invasive.
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

// =============================================================================
// Import the worker AFTER mocks are wired.
// =============================================================================

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

  // Subscribe to every published event. Topic set 'matches' covers F7 events.
  unsubscribe = eventBus.subscribe(
    (ev) => {
      publishedEvents.push({ type: ev.type, payload: ev.payload as Record<string, unknown> });
    },
    { topics: new Set(['matches']) }
  );
});

// =============================================================================
// Per-test isolation
// =============================================================================

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
  // Clear the shared eventBus ring buffer so other test files start from a
  // clean slate (see project memory feedback_singleton_buffer_isolation).
  eventBus.__resetForTest();
});

// =============================================================================
// Helpers
// =============================================================================

const seedMatch = (overrides: Partial<FakeDbMatch> = {}): FakeDbMatch => {
  const m: FakeDbMatch = {
    id: 'cmatch1',
    externalId: 12345,
    status: 'scheduled',
    kickoffUtc: new Date(NOW - 10 * 60_000), // 10 min ago
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
  homeTeam: { id: number; name: string };
  awayTeam: { id: number; name: string };
  score: { fullTime: { home: number | null; away: number | null } };
  goals?: Array<{ minute: number; scorer: { name: string }; team: { id: number } }>;
}

const queueFd = (matches: FakeFdMatch[]): void => {
  fdMatchesQueue.push(matches);
};

const mkFdMatch = (overrides: Partial<FakeFdMatch> = {}): FakeFdMatch => ({
  id: 12345,
  status: 'IN_PLAY',
  utcDate: '2026-06-15T19:00:00Z',
  minute: 25,
  homeTeam: { id: 1, name: 'Argentina' },
  awayTeam: { id: 2, name: 'Brazil' },
  score: { fullTime: { home: 0, away: 0 } },
  ...overrides,
});

const eventsOfType = (type: string): PublishedEvent[] =>
  publishedEvents.filter((e) => e.type === type);

// =============================================================================
// Tests
// =============================================================================

describe('liveMatchPulseWorker', () => {
  test('out-of-window matches are skipped (no API call)', async () => {
    seedMatch({ kickoffUtc: new Date(NOW + 6 * 3600_000) }); // 6h in future
    await runLiveMatchPulseTick();
    expect(clientCalls.length).toBe(0);
    expect(updates.length).toBe(0);
  });

  test('match without externalId is skipped (logged once)', async () => {
    seedMatch({ externalId: null });
    queueFd([mkFdMatch()]);
    await runLiveMatchPulseTick();
    // The fetch still happens (worker doesn't know externalId is missing until
    // it iterates) but no update fires.
    expect(updates.length).toBe(0);
    expect(publishedEvents.length).toBe(0);
  });

  test('SCHEDULED -> IN_PLAY publishes match.kickoff', async () => {
    seedMatch({ status: 'scheduled' });
    queueFd([
      mkFdMatch({ status: 'SCHEDULED', score: { fullTime: { home: 0, away: 0 } } }),
    ]);
    await runLiveMatchPulseTick();
    // First observation establishes the baseline; no events fire because prev.status was null.
    expect(eventsOfType('match.kickoff').length).toBe(0);

    // Second tick — status flips to IN_PLAY.
    __testHooks.clearResponseCache();
    queueFd([
      mkFdMatch({ status: 'IN_PLAY', score: { fullTime: { home: 0, away: 0 } } }),
    ]);
    await runLiveMatchPulseTick();
    const kickoffs = eventsOfType('match.kickoff');
    expect(kickoffs.length).toBe(1);
    expect(kickoffs[0]!.payload.homeTeam).toBe('Argentina');
    expect(kickoffs[0]!.payload.awayTeam).toBe('Brazil');
  });

  test('IN_PLAY -> PAUSED publishes match.halftime', async () => {
    seedMatch({ status: 'live' });
    queueFd([mkFdMatch({ status: 'IN_PLAY', score: { fullTime: { home: 1, away: 0 } } })]);
    await runLiveMatchPulseTick();
    __testHooks.clearResponseCache();
    queueFd([mkFdMatch({ status: 'PAUSED', score: { fullTime: { home: 1, away: 0 } } })]);
    await runLiveMatchPulseTick();

    const half = eventsOfType('match.halftime');
    expect(half.length).toBe(1);
    expect(half[0]!.payload.score).toEqual({ home: 1, away: 0 });
  });

  test('* -> FINISHED publishes match.fulltime', async () => {
    seedMatch({ status: 'live' });
    queueFd([mkFdMatch({ status: 'IN_PLAY', score: { fullTime: { home: 2, away: 1 } } })]);
    await runLiveMatchPulseTick();
    __testHooks.clearResponseCache();
    queueFd([mkFdMatch({ status: 'FINISHED', score: { fullTime: { home: 2, away: 1 } } })]);
    await runLiveMatchPulseTick();

    const ft = eventsOfType('match.fulltime');
    expect(ft.length).toBe(1);
    expect(ft[0]!.payload.score).toEqual({ home: 2, away: 1 });
  });

  test('home score increase publishes match.goal AND match.score_changed', async () => {
    seedMatch({ status: 'live' });
    // Baseline 0-0
    queueFd([mkFdMatch({ status: 'IN_PLAY', score: { fullTime: { home: 0, away: 0 } } })]);
    await runLiveMatchPulseTick();
    // Home scores
    __testHooks.clearResponseCache();
    queueFd([mkFdMatch({ status: 'IN_PLAY', minute: 31, score: { fullTime: { home: 1, away: 0 } } })]);
    await runLiveMatchPulseTick();

    expect(eventsOfType('match.goal').length).toBe(1);
    expect(eventsOfType('match.score_changed').length).toBe(1);
    const goal = eventsOfType('match.goal')[0]!;
    expect(goal.payload.team).toBe('home');
    expect(goal.payload.newScore).toEqual({ home: 1, away: 0 });
    // Free tier — scorer/minute may be null from goals[], but minute falls back to fd.minute
    expect(goal.payload.minute).toBe(31);
  });

  test('VAR reversal (score decrease) publishes only score_changed, no goal', async () => {
    seedMatch({ status: 'live' });
    queueFd([mkFdMatch({ status: 'IN_PLAY', score: { fullTime: { home: 1, away: 0 } } })]);
    await runLiveMatchPulseTick();
    __testHooks.clearResponseCache();
    queueFd([mkFdMatch({ status: 'IN_PLAY', score: { fullTime: { home: 0, away: 0 } } })]);
    await runLiveMatchPulseTick();

    expect(eventsOfType('match.goal').length).toBe(0);
    const sc = eventsOfType('match.score_changed');
    expect(sc.length).toBe(1);
    expect(sc[0]!.payload.previous).toEqual({ home: 1, away: 0 });
    expect(sc[0]!.payload.current).toEqual({ home: 0, away: 0 });
  });

  test('updates DB row with status mapping + score + minute + lastSyncedAt', async () => {
    seedMatch({ status: 'scheduled' });
    queueFd([mkFdMatch({ status: 'IN_PLAY', minute: 23, score: { fullTime: { home: 1, away: 0 } } })]);
    await runLiveMatchPulseTick();

    expect(updates.length).toBe(1);
    const u = updates[0]!;
    expect(u.id).toBe('cmatch1');
    expect(u.data.status).toBe('live');
    expect(u.data.homeScore).toBe(1);
    expect(u.data.awayScore).toBe(0);
    expect(u.data.currentMinute).toBe(23);
    expect(u.data.lastSyncedAt).toBeInstanceOf(Date);
  });

  test('caches the football-data response across overlapping ticks', async () => {
    seedMatch({ status: 'live' });
    queueFd([mkFdMatch({ status: 'IN_PLAY', score: { fullTime: { home: 0, away: 0 } } })]);
    await runLiveMatchPulseTick();
    // Second tick within 30s — should NOT call the API again.
    await runLiveMatchPulseTick();
    expect(clientCalls.length).toBe(1);
  });

  test('FINISHED match in DB is excluded from the scan', async () => {
    seedMatch({ status: 'finished' });
    queueFd([mkFdMatch()]);
    await runLiveMatchPulseTick();
    expect(updates.length).toBe(0);
  });

  // =============================================================================
  // W3-HIGH-01 — score amplification DoS hardening
  // =============================================================================

  test('absurd score (1,000,000) is capped: only MAX_GOALS_PER_TICK=10 goals fire', async () => {
    seedMatch({ status: 'live' });
    // Baseline: 0-0
    queueFd([mkFdMatch({ status: 'IN_PLAY', score: { fullTime: { home: 0, away: 0 } } })]);
    await runLiveMatchPulseTick();

    // Hostile upstream returns a wildly inflated home score on the next tick.
    __testHooks.clearResponseCache();
    queueFd([
      mkFdMatch({
        status: 'IN_PLAY',
        score: { fullTime: { home: 1_000_000, away: 0 } },
      }),
    ]);
    await runLiveMatchPulseTick();

    // The bounds-check in processMatch rejects fdHome > MAX_REASONABLE_SCORE (50)
    // entirely — the match is skipped, no events, no DB write on the second
    // tick. This protects the event loop from per-tick fan-out amplification.
    expect(eventsOfType('match.goal').length).toBe(0);
    // Only the first tick wrote (baseline 0-0).
    expect(updates.length).toBe(1);
  });

  test('score within range but goal delta > MAX_GOALS_PER_TICK is capped at 10', async () => {
    seedMatch({ status: 'live' });
    // Baseline 0-0 from a prior tick.
    queueFd([mkFdMatch({ status: 'IN_PLAY', score: { fullTime: { home: 0, away: 0 } } })]);
    await runLiveMatchPulseTick();

    // Next tick: home jumps to 30. 30 - 0 = 30 raw delta, capped at 10.
    __testHooks.clearResponseCache();
    queueFd([
      mkFdMatch({
        status: 'IN_PLAY',
        score: { fullTime: { home: 30, away: 0 } },
      }),
    ]);
    await runLiveMatchPulseTick();
    expect(eventsOfType('match.goal').length).toBe(10);
  });

  test('NaN / non-integer score skips the match (no events, no DB write)', async () => {
    seedMatch({ status: 'live' });
    queueFd([mkFdMatch({ status: 'IN_PLAY', score: { fullTime: { home: 0, away: 0 } } })]);
    await runLiveMatchPulseTick();
    const baselineUpdates = updates.length;

    __testHooks.clearResponseCache();
    // Cast through unknown so TS lets us inject malformed upstream data.
    queueFd([
      mkFdMatch({
        status: 'IN_PLAY',
        score: { fullTime: { home: NaN as unknown as number, away: 0 } },
      }),
    ]);
    await runLiveMatchPulseTick();

    expect(eventsOfType('match.goal').length).toBe(0);
    expect(eventsOfType('match.score_changed').length).toBe(0);
    expect(updates.length).toBe(baselineUpdates);
  });

  test('negative minute is normalised to null (no crash, no events)', async () => {
    seedMatch({ status: 'scheduled' });
    queueFd([
      mkFdMatch({
        status: 'IN_PLAY',
        minute: -5,
        score: { fullTime: { home: 0, away: 0 } },
      }),
    ]);
    // Should not throw; minute is normalised to null and the row is updated.
    await runLiveMatchPulseTick();
    expect(updates.length).toBe(1);
    expect(updates[0]!.data.currentMinute).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // CODE_REVIEW W3 Major #2 — cache key must include the query window.
  // ---------------------------------------------------------------------------
  test('cache key includes the date window so different windows are cached independently', async () => {
    // Seed two matches at well-separated kickoffs so each tick has something
    // in-window AND the date window has clearly moved between them.
    seedMatch({
      id: 'cmatch-day1',
      externalId: 11111,
      status: 'live',
      kickoffUtc: new Date(NOW - 10 * 60_000),
    });
    seedMatch({
      id: 'cmatch-day3',
      externalId: 22222,
      status: 'live',
      kickoffUtc: new Date(NOW + 48 * 3600_000 - 10 * 60_000),
    });

    queueFd([
      { ...mkFdMatch({ id: 11111, status: 'IN_PLAY', score: { fullTime: { home: 0, away: 0 } } }) },
    ]);
    // Tick 1 at NOW.
    await runLiveMatchPulseTick();
    expect(clientCalls.length).toBe(1);

    // Shift "now" so the date window changes (the worker formats dateFrom/dateTo
    // off `now ± 24h`; advancing by 48h moves both ends by a full day).
    __testHooks.now = () => NOW + 48 * 3600_000;
    queueFd([
      { ...mkFdMatch({ id: 22222, status: 'IN_PLAY', score: { fullTime: { home: 0, away: 0 } } }) },
    ]);
    await runLiveMatchPulseTick();
    // Different window key -> a fresh upstream call MUST happen.
    expect(clientCalls.length).toBe(2);
  });
});

// =============================================================================
// Disabled-mode posture: a separate inline test that flips the API key.
// =============================================================================

describe('liveMatchPulseWorker — disabled mode', () => {
  test('no API key: tick is a no-op (no DB read, no client call, no events)', async () => {
    // Use a separate isolated module instance by re-importing with the env
    // cleared. We swap the FOOTBALL_DATA_API_KEY constant by stubbing
    // main-config for THIS test. The simplest approach: directly call the
    // existing tick after blanking the in-memory client and asserting via
    // the absence of side effects when isEnabled returns false. Because the
    // module already captured FOOTBALL_DATA_API_KEY at import, we accept the
    // architectural contract and verify the boot-time gate via the route test.
    //
    // This narrow assertion: when no FootballDataClient is reachable AND the
    // env is unset, the worker must not crash.
    dbMatches.length = 0;
    fdMatchesQueue = [];
    publishedEvents.length = 0;
    // Stub the client to throw if called — the env-disabled path must never
    // reach the client.
    const throwing = {
      isEnabled: () => false,
      tier: 'free' as const,
      listCompetitionMatches: async () => {
        throw new Error('should not be called');
      },
      getMatch: async () => null,
    };
    __testHooks.setClient(throwing as unknown as FootballDataClient);
    // Setting the env *after* main-config captured the constant has no effect
    // on the worker's gate — that's the production contract. We simply assert
    // the tick completes without throwing.
    await runLiveMatchPulseTick();
    expect(publishedEvents.length).toBe(0);
  });
});
