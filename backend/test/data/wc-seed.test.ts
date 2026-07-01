import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const seedPath = resolve(process.cwd(), 'src/data/world-cup-2026.json');

interface Seed {
  meta: { competition: string };
  teams: Array<{ code: string; name: string; group: string | null; flagUrl: string; placeholder?: boolean }>;
  matches: Array<{
    externalId: number;
    homeTeamCode: string;
    awayTeamCode: string;
    kickoffUtc: string;
    stage: 'group' | 'r16' | 'qf' | 'sf' | 'third_place' | 'final';
    status: 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled';
    groupLabel: string | null;
  }>;
}

const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as Seed;

describe('World Cup 2026 seed', () => {
  test('has 48 real teams plus 1 TBD placeholder', () => {
    const realTeams = seed.teams.filter((t) => !t.placeholder);
    expect(realTeams.length).toBe(48);
  });

  test('every real team has ISO-3 code and flag URL', () => {
    for (const t of seed.teams.filter((t) => !t.placeholder)) {
      expect(t.code).toMatch(/^[A-Z]{3}$/);
      expect(t.flagUrl).toMatch(/^https:\/\/flagcdn\.com\/.+\.svg$/);
    }
  });

  test('every real team has a group A-L', () => {
    for (const t of seed.teams.filter((t) => !t.placeholder)) {
      expect(t.group).toMatch(/^[A-L]$/);
    }
  });

  test('each group has exactly 4 teams', () => {
    const groups = new Map<string, number>();
    for (const t of seed.teams) {
      if (t.group) groups.set(t.group, (groups.get(t.group) || 0) + 1);
    }
    expect(groups.size).toBe(12);
    for (const [_g, count] of groups) {
      expect(count).toBe(4);
    }
  });

  test('has 104 matches total', () => {
    expect(seed.matches.length).toBe(104);
  });

  test('has exactly 72 group matches (6 per group x 12)', () => {
    expect(seed.matches.filter((m) => m.stage === 'group').length).toBe(72);
  });

  test('matches are within tournament window', () => {
    const minKickoff = new Date('2026-06-10T00:00:00Z').getTime();
    const maxKickoff = new Date('2026-07-21T00:00:00Z').getTime();
    for (const m of seed.matches) {
      const t = new Date(m.kickoffUtc).getTime();
      expect(t).toBeGreaterThan(minKickoff);
      expect(t).toBeLessThan(maxKickoff);
    }
  });

  test('each match references known team codes', () => {
    const codes = new Set(seed.teams.map((t) => t.code));
    for (const m of seed.matches) {
      expect(codes.has(m.homeTeamCode)).toBe(true);
      expect(codes.has(m.awayTeamCode)).toBe(true);
    }
  });

  test('externalIds are unique', () => {
    const ids = seed.matches.map((m) => m.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
