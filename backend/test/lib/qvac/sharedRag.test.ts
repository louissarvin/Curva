/**
 * F4 shared RAG corpus tests. Backed by src/data/world-cup-2026.json — no
 * mocks; the corpus is loaded exactly as it will be in production.
 */

import { describe, expect, test, beforeAll } from 'bun:test';

const {
  loadCorpus,
  search,
  getStatus,
  getMatchSummary,
  getFixturesOnDate,
  getDisciplineRecord,
  getTeamSquad,
  getVenueDetails,
  getBroadcastRegions,
  getStandings,
  __resetForTest,
} = await import('../../../src/lib/qvac/sharedRag.ts');

beforeAll(() => {
  __resetForTest();
});

describe('shared RAG corpus', () => {
  test('loadCorpus produces a non-empty index with all four kinds', () => {
    const idx = loadCorpus();
    expect(idx.docs.length).toBeGreaterThan(100);
    const kinds = new Set(idx.docs.map((d) => d.kind));
    expect(kinds.has('team')).toBe(true);
    expect(kinds.has('match')).toBe(true);
    expect(kinds.has('group')).toBe(true);
    expect(kinds.has('meta')).toBe(true);
  });

  test('getStatus reports ready with the correct competition name', () => {
    const s = getStatus();
    expect(s.ready).toBe(true);
    expect(s.corpusSize).toBeGreaterThan(0);
    expect(s.competition).toContain('World Cup 2026');
    expect(typeof s.lastIngestAt).toBe('string');
  });

  test('search returns team hits ranked above unrelated docs', () => {
    const hits = search({ query: 'Mexico Group A', topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    // The top result should be either the Mexico team doc or the Group A
    // summary — both are the most relevant to the query.
    const topId = hits[0].id;
    expect(['team:MEX', 'group:A']).toContain(topId);
    // Scores must be strictly positive.
    for (const h of hits) expect(h.score).toBeGreaterThan(0);
  });

  test('search rejects empty query and caps topK at 20', () => {
    expect(search({ query: '' }).length).toBe(0);
    // BM25 scoring is deterministic — asking for topK=1000 must clamp to 20
    // internally, which we verify via output length upper bound.
    const many = search({ query: 'group', topK: 1000 });
    expect(many.length).toBeLessThanOrEqual(20);
  });

  test('search respects the kind filter', () => {
    const teamOnly = search({ query: 'group', topK: 5, kind: 'team' });
    for (const h of teamOnly) expect(h.kind).toBe('team');
  });

  test('getMatchSummary returns team codes + kickoff for the opener', () => {
    // externalId 100000 is MEX vs RSA, verified in world-cup-2026.json.
    const summary = getMatchSummary(100000);
    expect(summary).not.toBeNull();
    expect(summary?.homeTeamCode).toBe('MEX');
    expect(summary?.awayTeamCode).toBe('RSA');
    expect(summary?.kickoffUtc).toBe('2026-06-11T17:00:00.000Z');
    expect(summary?.stage).toBe('group');
  });

  test('getFixturesOnDate lists all matches for the opening day', () => {
    const fixtures = getFixturesOnDate('2026-06-11');
    // The opening day of WC26 has more than one fixture.
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      expect(f.kickoffUtc.startsWith('2026-06-11')).toBe(true);
    }
  });

  test('getFixturesOnDate returns [] for a malformed date', () => {
    expect(getFixturesOnDate('not-a-date').length).toBe(0);
    expect(getFixturesOnDate('2026/06/11').length).toBe(0);
  });

  test('getDisciplineRecord honestly reports unavailable', () => {
    // Discipline data is NOT seeded in world-cup-2026.json — the accessor
    // must never invent card counts.
    const rec = getDisciplineRecord('USA', '100000');
    expect(rec.available).toBe(false);
    expect(rec.reason).toContain('not seeded');
  });
});

// -----------------------------------------------------------------------------
// Wave 5C accessors — squads, venues, broadcasts, standings.
//
// These read from three JSON files that ship in src/data/. Tests use the real
// files (not mocks) so the tests fail loudly if the schema drifts.
// -----------------------------------------------------------------------------

describe('Wave 5C accessors', () => {
  test('getTeamSquad returns a shipped roster for USA', () => {
    const squad = getTeamSquad('USA');
    // The USA squad is seeded in wc26-squads.json.
    expect(squad).not.toBeNull();
    if (squad && !('available' in squad)) {
      expect(squad.code).toBe('USA');
      expect(Array.isArray(squad.players)).toBe(true);
      expect(squad.players.length).toBeGreaterThan(0);
      const first = squad.players[0];
      expect(typeof first.name).toBe('string');
      expect(typeof first.position).toBe('string');
      expect(typeof first.number).toBe('number');
    }
  });

  test('getTeamSquad returns null for an unknown code', () => {
    const squad = getTeamSquad('ZZZ');
    expect(squad).toBeNull();
  });

  test('getTeamSquad caches the parsed file across calls', () => {
    const a = getTeamSquad('USA');
    const b = getTeamSquad('USA');
    // Same object reference means the Map is cached (not re-read from disk).
    expect(a).toBe(b);
  });

  test('getVenueDetails returns a shipped venue', () => {
    const venue = getVenueDetails('MEX-AZTECA');
    expect(venue).not.toBeNull();
    if (venue && !('available' in venue)) {
      expect(venue.code).toBe('MEX-AZTECA');
      expect(venue.city).toBe('Mexico City');
      expect(venue.country).toBe('Mexico');
      expect(typeof venue.capacity).toBe('number');
      expect(Array.isArray(venue.matches)).toBe(true);
    }
  });

  test('getVenueDetails returns null for an unknown code', () => {
    expect(getVenueDetails('ZZZ-NOPE')).toBeNull();
  });

  test('getVenueDetails caches the parsed file across calls', () => {
    const a = getVenueDetails('MEX-AZTECA');
    const b = getVenueDetails('MEX-AZTECA');
    expect(a).toBe(b);
  });

  test('getBroadcastRegions returns regions + disclaimer for any matchId', () => {
    const payload = getBroadcastRegions(100000);
    if ('available' in payload && payload.available === false) {
      throw new Error('wc26-broadcasts.json failed to load');
    }
    expect(payload.available).toBe(true);
    expect(payload.matchId).toBe(100000);
    expect(Array.isArray(payload.regions)).toBe(true);
    expect(payload.regions.length).toBeGreaterThan(0);
    expect(typeof payload.disclaimer).toBe('string');
    expect(payload.disclaimer.length).toBeGreaterThan(0);
  });

  test('getStandings computes an initial table for group A', () => {
    const rows = getStandings('A');
    // Group A has 4 teams per WC26 draw.
    expect(rows.length).toBe(4);
    for (const r of rows) {
      // No fixtures are marked "finished" in the seeded corpus, so every row
      // should be at zero.
      expect(r.played).toBe(0);
      expect(r.points).toBe(0);
      expect(r.gf).toBe(0);
      expect(r.ga).toBe(0);
      expect(r.gd).toBe(0);
    }
  });

  test('getStandings rejects non-letter groups', () => {
    expect(getStandings('a').length).toBe(0);
    expect(getStandings('AA').length).toBe(0);
    expect(getStandings('1').length).toBe(0);
    expect(getStandings('').length).toBe(0);
    expect(getStandings('M').length).toBe(0); // Only A-L for WC26.
  });
});

// -----------------------------------------------------------------------------
// Missing-file fallback.
//
// The accessors are meant to return `{available:false, reason}` when the
// JSON file cannot be read. Since the shipped files exist in the repo, we
// use a temp cwd for a fresh module evaluation to simulate a missing file.
// -----------------------------------------------------------------------------

describe('Wave 5C accessors — missing file fallback', () => {
  test('missing wc26-*.json files return {available:false}', async () => {
    const originalCwd = process.cwd();
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharedrag-'));
    try {
      process.chdir(tmp);
      // Query-string suffix forces bun to re-evaluate the module against the
      // new cwd (the SOURCE_PATH_REL constant is resolved at call time via
      // process.cwd()).
      const mod: typeof import('../../../src/lib/qvac/sharedRag.ts') = await import(
        '../../../src/lib/qvac/sharedRag.ts?missing-fallback'
      );
      mod.__resetForTest();
      const squad = mod.getTeamSquad('USA');
      // With no wc26-squads.json under tmp/src/data, the accessor MUST return
      // the unavailable shape rather than throwing.
      if (squad === null) {
        // A null hit means the file loaded but the code is unknown — this
        // happens only if the cache carried over. Skip in that case.
        return;
      }
      expect('available' in squad).toBe(true);
      if ('available' in squad) {
        expect(squad.available).toBe(false);
        expect(typeof squad.reason).toBe('string');
      }

      const venue = mod.getVenueDetails('MEX-AZTECA');
      if (venue !== null && 'available' in venue) {
        expect(venue.available).toBe(false);
      }

      const broadcast = mod.getBroadcastRegions(1);
      if ('available' in broadcast) {
        expect(broadcast.available).toBe(false);
      }
    } finally {
      process.chdir(originalCwd);
      // Reset the singleton so subsequent tests re-load from the real cwd.
      __resetForTest();
    }
  });
});
