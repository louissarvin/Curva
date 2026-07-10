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
