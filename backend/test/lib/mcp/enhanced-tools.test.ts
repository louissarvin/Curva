/**
 * Wave 5C MCP tools tests.
 *
 * Covers the four new tools added in this wave:
 *   - roster.getSquad
 *   - venue.getDetails
 *   - standings.getTable
 *   - broadcast.getRegions
 *
 * These tools are pure JSON-file lookups (via sharedRag accessors). We mock the
 * accessors so the tests are hermetic — they do not depend on the actual
 * wc26-*.json contents and cannot be broken by a data update.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

// -----------------------------------------------------------------------------
// Mock sharedRag accessors BEFORE importing tools.ts.
// -----------------------------------------------------------------------------

const squadCallLog: string[] = [];
const venueCallLog: string[] = [];
const standingsCallLog: string[] = [];
const broadcastCallLog: number[] = [];

mock.module('../../../src/lib/qvac/sharedRag.ts', () => ({
  // Consumed accessors:
  getTeamSquad: (code: string) => {
    squadCallLog.push(code);
    if (code === 'USA') {
      return {
        code: 'USA',
        name: 'United States',
        players: [
          { name: 'Christian Pulisic', position: 'FW', number: 10 },
          { name: 'Tyler Adams', position: 'MF', number: 4 },
        ],
      };
    }
    if (code === 'MIS') {
      return { available: false, reason: 'squads file missing' };
    }
    return null;
  },
  getVenueDetails: (code: string) => {
    venueCallLog.push(code);
    if (code === 'MEX-AZTECA') {
      return {
        code: 'MEX-AZTECA',
        name: 'Estadio Azteca',
        city: 'Mexico City',
        country: 'Mexico',
        capacity: 87000,
        elevation_m: 2240,
        matches: ['opening'],
      };
    }
    if (code === 'MIS-SING') {
      return { available: false, reason: 'venues file missing' };
    }
    return null;
  },
  getStandings: (group: string) => {
    standingsCallLog.push(group);
    return [
      { teamCode: 'MEX', played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0 },
      { teamCode: 'RSA', played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0 },
    ];
  },
  getBroadcastRegions: (matchId: number) => {
    broadcastCallLog.push(matchId);
    if (matchId === 999999) {
      return { available: false, reason: 'broadcasts file missing' };
    }
    return {
      available: true,
      matchId,
      regions: [
        { region: 'USA', official_broadcasters: ['FOX'], streaming: ['Fubo'], matches_broadcast: 'all' },
      ],
      disclaimer: 'Sample data.',
    };
  },
  // Legacy accessors still referenced by pre-existing tools we do NOT
  // exercise here — return trivial stubs so the tools.ts import succeeds.
  getMatchSummary: () => null,
  getFixturesOnDate: () => [],
  getDisciplineRecord: () => ({ available: false, reason: 'stub' }),
}));

// -----------------------------------------------------------------------------
// Track recordMcpToolCall invocations from observability.
// -----------------------------------------------------------------------------

const metricCalls: Array<{ tool: string; outcome: string }> = [];
mock.module('../../../src/lib/observability.ts', () => ({
  recordMcpToolCall: (tool: string, outcome: string) => {
    metricCalls.push({ tool, outcome });
  },
}));

// -----------------------------------------------------------------------------
// Now import tools.
// -----------------------------------------------------------------------------

const toolsModule = await import('../../../src/lib/mcp/tools.ts');
const { __toolsForTest } = toolsModule;
const CTX: import('../../../src/lib/mcp/server.ts').McpContext = {
  lang: 'en',
  ip: '127.0.0.1',
};

beforeAll(() => {
  metricCalls.length = 0;
  squadCallLog.length = 0;
  venueCallLog.length = 0;
  standingsCallLog.length = 0;
  broadcastCallLog.length = 0;
});

afterAll(() => {
  /* no cleanup */
});

// -----------------------------------------------------------------------------
// roster.getSquad
// -----------------------------------------------------------------------------

describe('roster.getSquad', () => {
  test('returns the squad for a valid team code', async () => {
    const res = await __toolsForTest.rosterGetSquadTool.handler({ teamCode: 'USA' }, CTX);
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as { code: string; players: unknown[] };
    expect(data.code).toBe('USA');
    expect(Array.isArray(data.players)).toBe(true);
    expect(data.players.length).toBe(2);
    // metric fired with ok outcome
    expect(metricCalls.some((c) => c.tool === 'roster.getSquad' && c.outcome === 'ok')).toBe(true);
  });

  test('rejects non-uppercase / wrong-length codes', async () => {
    for (const bad of ['usa', 'US', 'USAA', '123', '', 'US1']) {
      const res = await __toolsForTest.rosterGetSquadTool.handler({ teamCode: bad }, CTX);
      expect(res.isError).toBe(true);
    }
    expect(metricCalls.filter((c) => c.tool === 'roster.getSquad' && c.outcome === 'error').length)
      .toBeGreaterThanOrEqual(6);
  });

  test('returns error for unknown team', async () => {
    const res = await __toolsForTest.rosterGetSquadTool.handler({ teamCode: 'ZZZ' }, CTX);
    expect(res.isError).toBe(true);
  });

  test('propagates {available:false} from accessor', async () => {
    const res = await __toolsForTest.rosterGetSquadTool.handler({ teamCode: 'MIS' }, CTX);
    // Unavailable is not an error to the caller in the same way — we surface
    // the {available:false} shape so agents can degrade gracefully.
    const data = res.structuredContent as { available: boolean };
    expect(data.available).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// venue.getDetails
// -----------------------------------------------------------------------------

describe('venue.getDetails', () => {
  test('returns venue for a valid code', async () => {
    const res = await __toolsForTest.venueGetDetailsTool.handler(
      { stadiumCode: 'MEX-AZTECA' },
      CTX
    );
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as { code: string; capacity: number };
    expect(data.code).toBe('MEX-AZTECA');
    expect(data.capacity).toBe(87000);
    expect(metricCalls.some((c) => c.tool === 'venue.getDetails' && c.outcome === 'ok')).toBe(true);
  });

  test('rejects malformed codes', async () => {
    for (const bad of ['mex-azteca', 'MEX_AZTECA', 'M-A', '-AZTECA', 'MEX-', 'X-']) {
      const res = await __toolsForTest.venueGetDetailsTool.handler({ stadiumCode: bad }, CTX);
      expect(res.isError).toBe(true);
    }
  });

  test('propagates {available:false} on missing file', async () => {
    const res = await __toolsForTest.venueGetDetailsTool.handler(
      { stadiumCode: 'MIS-SING' },
      CTX
    );
    const data = res.structuredContent as { available: boolean };
    expect(data.available).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// standings.getTable
// -----------------------------------------------------------------------------

describe('standings.getTable', () => {
  test('returns the standings table for a valid group letter', async () => {
    const res = await __toolsForTest.standingsGetTableTool.handler({ group: 'A' }, CTX);
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as {
      group: string;
      table: Array<{ teamCode: string; points: number }>;
    };
    expect(data.group).toBe('A');
    expect(Array.isArray(data.table)).toBe(true);
    expect(data.table.length).toBeGreaterThan(0);
    // Every row has the expected keys.
    for (const row of data.table) {
      expect(typeof row.teamCode).toBe('string');
      expect(typeof row.points).toBe('number');
    }
    expect(metricCalls.some((c) => c.tool === 'standings.getTable' && c.outcome === 'ok')).toBe(
      true
    );
  });

  test('rejects invalid group letters', async () => {
    for (const bad of ['a', 'M', 'AA', '1', '', 'Group A']) {
      const res = await __toolsForTest.standingsGetTableTool.handler({ group: bad }, CTX);
      expect(res.isError).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// broadcast.getRegions
// -----------------------------------------------------------------------------

describe('broadcast.getRegions', () => {
  test('returns regions + disclaimer for a valid matchId', async () => {
    const res = await __toolsForTest.broadcastGetRegionsTool.handler(
      { matchId: 100000 },
      CTX
    );
    expect(res.isError).toBeUndefined();
    const data = res.structuredContent as {
      matchId: number;
      regions: Array<{ region: string }>;
      disclaimer: string;
    };
    expect(data.matchId).toBe(100000);
    expect(Array.isArray(data.regions)).toBe(true);
    expect(typeof data.disclaimer).toBe('string');
    expect(data.disclaimer.length).toBeGreaterThan(0);
    expect(metricCalls.some((c) => c.tool === 'broadcast.getRegions' && c.outcome === 'ok')).toBe(
      true
    );
  });

  test('rejects non-integer / negative matchIds', async () => {
    for (const bad of [-1, 0, 1.5, Number.NaN, 'abc' as unknown as number]) {
      const res = await __toolsForTest.broadcastGetRegionsTool.handler(
        { matchId: bad as number },
        CTX
      );
      expect(res.isError).toBe(true);
    }
  });

  test('propagates {available:false} on missing file', async () => {
    const res = await __toolsForTest.broadcastGetRegionsTool.handler(
      { matchId: 999999 },
      CTX
    );
    const data = res.structuredContent as { available: boolean };
    expect(data.available).toBe(false);
  });
});
