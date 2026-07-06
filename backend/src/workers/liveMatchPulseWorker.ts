/**
 * Live match pulse worker (F7 / ARCHITECTURE.md Section 20).
 *
 * Polls football-data.org once per tick during the live-match window and
 * publishes match.* events to the in-process eventBus so the dashboard (F8)
 * and Pear app can render goal overlays within ~60s of the on-field event.
 *
 * Operational notes:
 *  - Worker no-ops when FOOTBALL_DATA_API_KEY is unset. Throttles the disabled
 *    log to at most once per hour (mirrors matchAutoWarmWorker pattern).
 *  - One bulk HTTP call per tick (GET /v4/competitions/WC/matches?...).
 *  - In-memory `lastSeen` snapshot tracks per-match status + score so we only
 *    publish events on transitions.
 *  - In-memory `goalLog` (separate module) backs the `/matches/:id/live`
 *    endpoint's `goals[]` array.
 *  - 30s response cache de-dupes overlapping ticks.
 *  - All HTTP errors are swallowed; one bad tick never crashes the API process.
 *
 * Status mapping (football-data → MatchStatus enum):
 *   SCHEDULED / TIMED                 → 'scheduled'
 *   IN_PLAY / LIVE / PAUSED           → 'live'    (PAUSED triggers halftime event but row stays 'live')
 *   FINISHED / AWARDED                → 'finished'
 *   POSTPONED                         → 'postponed'
 *   SUSPENDED / CANCELED / CANCELLED  → 'cancelled'
 */

import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';

type MatchStatus = 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled';
import { eventBus } from '../lib/activity/eventBus.ts';
import { append as appendGoal } from '../lib/liveMatch/goalLog.ts';
import {
  FootballDataClient,
  type FdMatch,
  type FdMatchStatus,
} from '../lib/integrations/footballData.ts';
import {
  FOOTBALL_DATA_API_KEY,
  FOOTBALL_DATA_API_TIER,
  LIVE_MATCH_PULSE_CACHE_TTL_MS,
  LIVE_MATCH_PULSE_COMPETITION_CODE,
  LIVE_MATCH_PULSE_CRON,
  LIVE_MATCH_PULSE_MATCHES_PER_TICK,
  LIVE_MATCH_PULSE_WINDOW_AFTER_MIN,
  LIVE_MATCH_PULSE_WINDOW_BEFORE_MIN,
} from '../config/main-config.ts';

// -----------------------------------------------------------------------------
// Disabled-mode log throttling (mirrors matchAutoWarmWorker; see CODE_REVIEW W2)
// -----------------------------------------------------------------------------

const DISABLED_LOG_THROTTLE_MS = 3_600_000;
let lastDisabledLogAt = 0;
let isRunning = false;

// -----------------------------------------------------------------------------
// Per-process state
// -----------------------------------------------------------------------------

interface LastSeen {
  status: FdMatchStatus | null;
  homeScore: number;
  awayScore: number;
  minute: number | null;
}

const lastSeen = new Map<string, LastSeen>(); // keyed by internal match.id
const matchesWithoutExternalIdLogged = new Set<string>();

// 30s response cache so a double-tick within the window does not double-call.
// CODE_REVIEW W3 Major: cache key MUST include every input that determines the
// upstream response (competition + date window) so a window change between
// ticks does not silently serve stale data. Bounded LRU at 32 entries.
interface CachedEntry {
  key: string;
  matches: FdMatch[];
  fetchedAt: number;
}
const CACHE_MAX_ENTRIES = 32;
const responseCache: Map<string, CachedEntry> = new Map();
const cacheEvictIfNeeded = (): void => {
  while (responseCache.size > CACHE_MAX_ENTRIES) {
    const firstKey = responseCache.keys().next().value;
    if (firstKey === undefined) break;
    responseCache.delete(firstKey);
  }
};

// Lazily constructed so tests can override env before the module ticks.
let client: FootballDataClient | null = null;
const getClient = (): FootballDataClient => {
  if (!client) {
    client = new FootballDataClient({
      apiKey: FOOTBALL_DATA_API_KEY,
      tier: FOOTBALL_DATA_API_TIER,
    });
  }
  return client;
};

// -----------------------------------------------------------------------------
// Test seam
// -----------------------------------------------------------------------------

export const __testHooks = {
  now: (): number => Date.now(),
  /** Inject a custom client (e.g. one with a stub axios instance). */
  setClient: (c: FootballDataClient | null): void => {
    client = c;
  },
  resetState: (): void => {
    lastSeen.clear();
    matchesWithoutExternalIdLogged.clear();
    responseCache.clear();
    lastDisabledLogAt = 0;
  },
  /** Clear only the 30s response cache, keeping the lastSeen snapshot. */
  clearResponseCache: (): void => {
    responseCache.clear();
  },
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const mapFdStatusToEnum = (fd: FdMatchStatus): MatchStatus => {
  switch (fd) {
    case 'SCHEDULED':
    case 'TIMED':
      return 'scheduled';
    case 'LIVE':
    case 'IN_PLAY':
    case 'PAUSED':
      return 'live';
    case 'FINISHED':
    case 'AWARDED':
      return 'finished';
    case 'POSTPONED':
      return 'postponed';
    case 'SUSPENDED':
    case 'CANCELED':
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'scheduled';
  }
};

const formatYmd = (d: Date): string => {
  // YYYY-MM-DD in UTC (football-data.org dates are UTC).
  return d.toISOString().slice(0, 10);
};

const isEnabled = (): boolean => Boolean(FOOTBALL_DATA_API_KEY);

const logDisabledOnce = (now: number): void => {
  if (lastDisabledLogAt === 0 || now - lastDisabledLogAt > DISABLED_LOG_THROTTLE_MS) {
    console.log('[liveMatchPulseWorker] disabled (no FOOTBALL_DATA_API_KEY)');
    lastDisabledLogAt = now;
  }
};

const logMissingExternalIdOnce = (matchId: string): void => {
  if (matchesWithoutExternalIdLogged.has(matchId)) return;
  matchesWithoutExternalIdLogged.add(matchId);
  console.warn(
    `[liveMatchPulseWorker] match ${matchId} has no externalId; cannot poll live data`
  );
};

interface DbMatchSlim {
  id: string;
  externalId: number | null;
  status: MatchStatus;
  kickoffUtc: Date;
  homeScore: number | null;
  awayScore: number | null;
  homeTeam: { name: string };
  awayTeam: { name: string };
}

// -----------------------------------------------------------------------------
// Per-match diff + event publish
// -----------------------------------------------------------------------------

// Hard ceilings to defend against hostile or malformed upstream responses
// (SECURITY_AUDIT.md W3-HIGH-01 / W3-MED-02). The football-data.org schema
// makes no guarantees about score/minute integrity, and OWASP API10:2023
// (Unsafe Consumption of APIs) prescribes server-side bounds-checking on
// every consumed value before persistence or fan-out.
const MAX_REASONABLE_SCORE = 50;
const MAX_GOALS_PER_TICK = 10;
const MAX_REASONABLE_MINUTE = 200;
// Football referees typically allow at most ~15 minutes of added time even in
// hostile edge cases. 30 is a generous ceiling that still filters out obvious
// upstream corruption (e.g. accidental seconds-cast). Anything above is coerced
// to null so the badge falls back to a plain minute display.
const MAX_REASONABLE_INJURY_TIME = 30;

const processMatch = async (dbMatch: DbMatchSlim, fd: FdMatch, now: number): Promise<void> => {
  const prev = lastSeen.get(dbMatch.id) ?? {
    status: null,
    homeScore: dbMatch.homeScore ?? 0,
    awayScore: dbMatch.awayScore ?? 0,
    minute: null,
  };

  // ---------------------------------------------------------------------------
  // Bounds-check upstream-controlled score/minute (W3-HIGH-01, W3-MED-02).
  // - Reject non-integer or out-of-range scores entirely (skip this match
  //   so the tick survives a poisoned upstream).
  // - Normalise minute to null on non-integer / out-of-range.
  // ---------------------------------------------------------------------------
  const fdHomeRaw = fd.score?.fullTime?.home;
  const fdAwayRaw = fd.score?.fullTime?.away;
  const fdHomeCandidate = fdHomeRaw === null || fdHomeRaw === undefined ? 0 : fdHomeRaw;
  const fdAwayCandidate = fdAwayRaw === null || fdAwayRaw === undefined ? 0 : fdAwayRaw;

  if (
    !Number.isInteger(fdHomeCandidate) ||
    fdHomeCandidate < 0 ||
    fdHomeCandidate > MAX_REASONABLE_SCORE ||
    !Number.isInteger(fdAwayCandidate) ||
    fdAwayCandidate < 0 ||
    fdAwayCandidate > MAX_REASONABLE_SCORE
  ) {
    console.warn(
      `[liveMatchPulseWorker] implausible score for match ${dbMatch.id}: ${String(fdHomeRaw)}-${String(fdAwayRaw)}; skipping`
    );
    return;
  }
  const fdHome = fdHomeCandidate;
  const fdAway = fdAwayCandidate;

  const fdMinuteRaw = fd.minute;
  const fdMinute: number | null =
    typeof fdMinuteRaw === 'number' &&
    Number.isInteger(fdMinuteRaw) &&
    fdMinuteRaw >= 0 &&
    fdMinuteRaw <= MAX_REASONABLE_MINUTE
      ? fdMinuteRaw
      : null;
  const fdStatus = fd.status;
  const ourStatus = mapFdStatusToEnum(fdStatus);

  // ---------------------------------------------------------------------------
  // Status transitions
  // ---------------------------------------------------------------------------

  const wasPreLive =
    prev.status === null || prev.status === 'SCHEDULED' || prev.status === 'TIMED';
  const isNowLive = fdStatus === 'IN_PLAY' || fdStatus === 'LIVE';
  const wasLive = prev.status === 'IN_PLAY' || prev.status === 'LIVE';
  const wasPaused = prev.status === 'PAUSED';

  if (wasPreLive && isNowLive) {
    try {
      eventBus.publish('match.kickoff', {
        matchId: dbMatch.id,
        homeTeam: dbMatch.homeTeam.name,
        awayTeam: dbMatch.awayTeam.name,
        kickoffUtc: dbMatch.kickoffUtc.toISOString(),
      });
    } catch (err) {
      console.warn('[liveMatchPulseWorker] kickoff publish failed:', (err as Error)?.message);
    }
  }

  if (wasLive && fdStatus === 'PAUSED') {
    try {
      eventBus.publish('match.halftime', {
        matchId: dbMatch.id,
        score: { home: fdHome, away: fdAway },
      });
    } catch (err) {
      console.warn('[liveMatchPulseWorker] halftime publish failed:', (err as Error)?.message);
    }
  }

  const justFinished =
    (wasLive || wasPaused || wasPreLive) && (fdStatus === 'FINISHED' || fdStatus === 'AWARDED');
  if (justFinished) {
    try {
      eventBus.publish('match.fulltime', {
        matchId: dbMatch.id,
        score: { home: fdHome, away: fdAway },
      });
    } catch (err) {
      console.warn('[liveMatchPulseWorker] fulltime publish failed:', (err as Error)?.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Score transitions (handles VAR reversals via score_changed without goal).
  // ---------------------------------------------------------------------------

  const rawHomeDelta = fdHome - prev.homeScore;
  const rawAwayDelta = fdAway - prev.awayScore;
  // Cap POSITIVE deltas (a one-tick goal blizzard from a hostile or buggy
  // upstream must not be amplified into millions of SSE events). Negative
  // deltas (VAR reversals) and zero are left alone — they don't cost work.
  // See SECURITY_AUDIT.md W3-HIGH-01.
  const homeDelta = rawHomeDelta > MAX_GOALS_PER_TICK ? MAX_GOALS_PER_TICK : rawHomeDelta;
  const awayDelta = rawAwayDelta > MAX_GOALS_PER_TICK ? MAX_GOALS_PER_TICK : rawAwayDelta;
  if (rawHomeDelta > MAX_GOALS_PER_TICK) {
    console.warn(
      `[liveMatchPulseWorker] Capped home goal delta from ${rawHomeDelta} to ${MAX_GOALS_PER_TICK} for match ${dbMatch.id} (suspicious upstream response)`
    );
  }
  if (rawAwayDelta > MAX_GOALS_PER_TICK) {
    console.warn(
      `[liveMatchPulseWorker] Capped away goal delta from ${rawAwayDelta} to ${MAX_GOALS_PER_TICK} for match ${dbMatch.id} (suspicious upstream response)`
    );
  }
  const scoreChanged = homeDelta !== 0 || awayDelta !== 0;
  // Only publish score_changed when we have a baseline (prev.status !== null).
  // The very first observation should not pretend the score just changed from 0.
  if (scoreChanged && prev.status !== null) {
    try {
      eventBus.publish('match.score_changed', {
        matchId: dbMatch.id,
        previous: { home: prev.homeScore, away: prev.awayScore },
        current: { home: fdHome, away: fdAway },
      });
    } catch (err) {
      console.warn(
        '[liveMatchPulseWorker] score_changed publish failed:',
        (err as Error)?.message
      );
    }
  }

  // Goal events: only fire on a strict increase. Multiple increments per tick
  // are rare (almost never two goals within 60s) but we publish per-increment.
  const publishGoalEvent = (team: 'home' | 'away', count: number): void => {
    if (count <= 0 || prev.status === null) return;
    // Pull the most recent matching goals from goals[] if available. Free tier
    // returns no goals[] so we fall back to nulls.
    const goalsList = Array.isArray(fd.goals) ? fd.goals : [];
    for (let i = 0; i < count; i++) {
      let scorer: string | null = null;
      let minute: number | null = fdMinute;
      if (FOOTBALL_DATA_API_TIER === 'livescores' && goalsList.length > 0) {
        // Take the last `count - i`th entry (oldest → newest within this tick).
        const idx = goalsList.length - count + i;
        const g = idx >= 0 ? goalsList[idx] : undefined;
        if (g) {
          scorer = g.scorer?.name ?? null;
          minute = typeof g.minute === 'number' ? g.minute : minute;
        }
      }
      try {
        eventBus.publish('match.goal', {
          matchId: dbMatch.id,
          team,
          newScore: { home: fdHome, away: fdAway },
          scorer,
          minute,
        });
      } catch (err) {
        console.warn('[liveMatchPulseWorker] goal publish failed:', (err as Error)?.message);
      }
      appendGoal(dbMatch.id, {
        minute,
        team,
        scorer,
        homeScoreAfter: fdHome,
        awayScoreAfter: fdAway,
        observedAt: now,
      });
    }
  };

  if (homeDelta > 0) publishGoalEvent('home', homeDelta);
  if (awayDelta > 0) publishGoalEvent('away', awayDelta);

  // ---------------------------------------------------------------------------
  // Persist row state
  // ---------------------------------------------------------------------------

  try {
    await prismaQuery.match.update({
      where: { id: dbMatch.id },
      data: {
        status: ourStatus,
        homeScore: fdHome,
        awayScore: fdAway,
        currentMinute: fdMinute,
        lastSyncedAt: new Date(now),
      },
    });
  } catch (err) {
    console.warn(
      `[liveMatchPulseWorker] db update failed for ${dbMatch.id}:`,
      (err as Error)?.message
    );
  }

  // ---------------------------------------------------------------------------
  // Update snapshot
  // ---------------------------------------------------------------------------

  lastSeen.set(dbMatch.id, {
    status: fdStatus,
    homeScore: fdHome,
    awayScore: fdAway,
    minute: fdMinute,
  });

  // ---------------------------------------------------------------------------
  // Live minute pulse (Cup Final overlay). Publishes on every tick per
  // in-window match so the SSE route can re-emit it as an enriched
  // `match.pulse` frame. Bounds-check injuryTime the same way we bounds-check
  // score and minute upstream (OWASP API10:2023).
  // ---------------------------------------------------------------------------
  const fdInjuryRaw = (fd as { injuryTime?: number | null }).injuryTime;
  const fdInjury: number | null =
    typeof fdInjuryRaw === 'number' &&
    Number.isInteger(fdInjuryRaw) &&
    fdInjuryRaw >= 0 &&
    fdInjuryRaw <= MAX_REASONABLE_INJURY_TIME
      ? fdInjuryRaw
      : null;
  try {
    eventBus.publish('match.minute', {
      matchId: dbMatch.id,
      minute: fdMinute,
      status: fdStatus,
      injuryTime: fdInjury,
    });
  } catch (err) {
    console.warn('[liveMatchPulseWorker] minute publish failed:', (err as Error)?.message);
  }
};

// -----------------------------------------------------------------------------
// Tick
// -----------------------------------------------------------------------------

export const runLiveMatchPulseTick = async (): Promise<void> => {
  const now = __testHooks.now();

  if (!isEnabled()) {
    logDisabledOnce(now);
    return;
  }
  if (isRunning) {
    console.log('[liveMatchPulseWorker] Previous run still active, skipping...');
    return;
  }
  isRunning = true;

  try {
    const nowDate = new Date(now);
    const windowStart = new Date(now - LIVE_MATCH_PULSE_WINDOW_AFTER_MIN * 60_000);
    const windowEnd = new Date(now + LIVE_MATCH_PULSE_WINDOW_BEFORE_MIN * 60_000);

    // Find matches whose kickoff window overlaps the current poll window AND
    // are not already in a terminal status. Cap to a sensible number per tick
    // to keep the response cheap.
    const dbMatches = (await prismaQuery.match.findMany({
      where: {
        status: { notIn: ['finished', 'cancelled', 'postponed'] },
        kickoffUtc: { gte: windowStart, lte: windowEnd },
      },
      take: LIVE_MATCH_PULSE_MATCHES_PER_TICK,
      orderBy: { kickoffUtc: 'asc' },
      include: {
        homeTeam: { select: { name: true } },
        awayTeam: { select: { name: true } },
      },
    })) as DbMatchSlim[];

    if (dbMatches.length === 0) return;

    // Fetch live matches in a small date window. We poll a 1-day window so a
    // tournament-day's full schedule is covered with one call.
    // Cache key includes EVERY input that affects the upstream response so
    // a date-window change between ticks never serves stale data
    // (CODE_REVIEW W3 Major).
    const dateFrom = formatYmd(new Date(now - 24 * 3600_000));
    const dateTo = formatYmd(new Date(now + 24 * 3600_000));
    const cacheKey = `${LIVE_MATCH_PULSE_COMPETITION_CODE}|${dateFrom}|${dateTo}`;
    let fdMatches: FdMatch[] = [];
    const cached = responseCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < LIVE_MATCH_PULSE_CACHE_TTL_MS) {
      fdMatches = cached.matches;
    } else {
      try {
        fdMatches = await getClient().listCompetitionMatches({
          competitionCode: LIVE_MATCH_PULSE_COMPETITION_CODE,
          dateFrom,
          dateTo,
        });
      } catch (err) {
        // Defence in depth — client should not throw, but if it does, swallow.
        console.warn('[liveMatchPulseWorker] fetch failed:', (err as Error)?.message);
        fdMatches = [];
      }
      // LRU-touch: delete-then-set so the entry is most-recently-used.
      responseCache.delete(cacheKey);
      responseCache.set(cacheKey, { key: cacheKey, matches: fdMatches, fetchedAt: now });
      cacheEvictIfNeeded();
    }

    const byExternalId = new Map<number, FdMatch>();
    for (const m of fdMatches) {
      if (typeof m.id === 'number') byExternalId.set(m.id, m);
    }

    for (const dbMatch of dbMatches) {
      if (dbMatch.externalId === null || dbMatch.externalId === undefined) {
        logMissingExternalIdOnce(dbMatch.id);
        continue;
      }
      const fd = byExternalId.get(dbMatch.externalId);
      if (!fd) continue;
      try {
        await processMatch(dbMatch, fd, nowDate.getTime());
      } catch (err) {
        // Per-match guard so one bad row never poisons the tick.
        console.error(
          `[liveMatchPulseWorker] processMatch failed for ${dbMatch.id}:`,
          (err as Error)?.message
        );
      }
    }
  } catch (err) {
    console.error('[liveMatchPulseWorker] tick failed:', (err as Error)?.message);
  } finally {
    isRunning = false;
  }
};

// -----------------------------------------------------------------------------
// Cron registration
// -----------------------------------------------------------------------------

export const startLiveMatchPulseWorker = (): void => {
  if (!isEnabled()) {
    console.warn('[liveMatchPulseWorker] Disabled (FOOTBALL_DATA_API_KEY not set)');
    // Still schedule a no-op cron so toggling the env via redeploy enables it
    // without code changes (mirrors matchAutoWarmWorker).
    cron.schedule(LIVE_MATCH_PULSE_CRON, runLiveMatchPulseTick);
    return;
  }
  console.log(
    `[liveMatchPulseWorker] scheduled: ${LIVE_MATCH_PULSE_CRON} (tier=${FOOTBALL_DATA_API_TIER}, comp=${LIVE_MATCH_PULSE_COMPETITION_CODE})`
  );
  cron.schedule(LIVE_MATCH_PULSE_CRON, runLiveMatchPulseTick);
};
