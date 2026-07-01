/**
 * F7 unit tests for FootballDataClient.
 *
 * We inject a stub axios instance via the constructor's `axiosInstance`
 * test seam. No real HTTP is made.
 */

import { describe, expect, test } from 'bun:test';
import { FootballDataClient } from '../../../src/lib/integrations/footballData.ts';

interface StubResponse {
  status: number;
  data: unknown;
}

interface FakeAxios {
  get: (url: string, opts?: unknown) => Promise<StubResponse>;
  calls: Array<{ url: string; opts?: unknown }>;
}

const makeStub = (
  responder: (url: string, opts?: unknown) => Promise<StubResponse> | StubResponse
): FakeAxios => {
  const calls: FakeAxios['calls'] = [];
  return {
    calls,
    get: async (url: string, opts?: unknown) => {
      calls.push({ url, opts });
      return await responder(url, opts);
    },
  };
};

describe('FootballDataClient', () => {
  test('isEnabled() is false when apiKey is unset', () => {
    const client = new FootballDataClient({ apiKey: undefined });
    expect(client.isEnabled()).toBe(false);
  });

  test('isEnabled() is false on empty/whitespace apiKey', () => {
    expect(new FootballDataClient({ apiKey: '   ' }).isEnabled()).toBe(false);
    expect(new FootballDataClient({ apiKey: '' }).isEnabled()).toBe(false);
  });

  test('isEnabled() is true with a real-looking apiKey', () => {
    const client = new FootballDataClient({ apiKey: 'k' });
    expect(client.isEnabled()).toBe(true);
  });

  test('tier defaults to free, accepts livescores override', () => {
    expect(new FootballDataClient({ apiKey: 'k' }).tier).toBe('free');
    expect(new FootballDataClient({ apiKey: 'k', tier: 'livescores' }).tier).toBe(
      'livescores'
    );
  });

  test('listCompetitionMatches returns [] when disabled (no HTTP)', async () => {
    const stub = makeStub(() => ({ status: 200, data: { matches: [] } }));
    const client = new FootballDataClient({
      apiKey: undefined,
      axiosInstance: stub as unknown as never,
    });
    const result = await client.listCompetitionMatches({
      competitionCode: 'WC',
      dateFrom: '2026-06-11',
      dateTo: '2026-06-12',
    });
    expect(result).toEqual([]);
    expect(stub.calls.length).toBe(0);
  });

  test('listCompetitionMatches parses 200 OK', async () => {
    const stub = makeStub(() => ({
      status: 200,
      data: {
        matches: [
          {
            id: 12345,
            status: 'IN_PLAY',
            utcDate: '2026-06-11T17:00:00Z',
            homeTeam: { id: 1, name: 'Argentina' },
            awayTeam: { id: 2, name: 'Brazil' },
            score: { fullTime: { home: 1, away: 0 } },
            minute: 23,
          },
        ],
      },
    }));
    const client = new FootballDataClient({
      apiKey: 'k',
      axiosInstance: stub as unknown as never,
    });
    const result = await client.listCompetitionMatches({
      competitionCode: 'WC',
      dateFrom: '2026-06-11',
      dateTo: '2026-06-12',
    });
    expect(result.length).toBe(1);
    expect(result[0]!.id).toBe(12345);
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]!.url).toBe('/competitions/WC/matches');
  });

  test('listCompetitionMatches returns [] on malformed body', async () => {
    const stub = makeStub(() => ({ status: 200, data: { wrongShape: true } }));
    const client = new FootballDataClient({
      apiKey: 'k',
      axiosInstance: stub as unknown as never,
    });
    const result = await client.listCompetitionMatches({
      competitionCode: 'WC',
      dateFrom: '2026-06-11',
      dateTo: '2026-06-12',
    });
    expect(result).toEqual([]);
  });

  test('listCompetitionMatches returns [] and logs on 429', async () => {
    const stub = makeStub(() => ({ status: 429, data: { error: 'rate' } }));
    const client = new FootballDataClient({
      apiKey: 'k',
      axiosInstance: stub as unknown as never,
    });
    const result = await client.listCompetitionMatches({
      competitionCode: 'WC',
      dateFrom: '2026-06-11',
      dateTo: '2026-06-12',
    });
    expect(result).toEqual([]);
    // Did not retry — backoff is until next cron tick.
    expect(stub.calls.length).toBe(1);
    // Client stays enabled (rate limit is transient).
    expect(client.isEnabled()).toBe(true);
  });

  test('401 disables the client for the rest of the process', async () => {
    const stub = makeStub(() => ({ status: 401, data: { error: 'bad key' } }));
    const client = new FootballDataClient({
      apiKey: 'k',
      axiosInstance: stub as unknown as never,
    });
    const first = await client.listCompetitionMatches({
      competitionCode: 'WC',
      dateFrom: '2026-06-11',
      dateTo: '2026-06-12',
    });
    expect(first).toEqual([]);
    expect(client.isEnabled()).toBe(false);

    // Subsequent call must not make HTTP.
    const second = await client.listCompetitionMatches({
      competitionCode: 'WC',
      dateFrom: '2026-06-11',
      dateTo: '2026-06-12',
    });
    expect(second).toEqual([]);
    expect(stub.calls.length).toBe(1);
  });

  test('5xx triggers one retry then returns []', async () => {
    let n = 0;
    const stub = makeStub(() => {
      n += 1;
      return { status: 500, data: { error: 'boom' } };
    });
    const client = new FootballDataClient({
      apiKey: 'k',
      axiosInstance: stub as unknown as never,
    });
    const result = await client.listCompetitionMatches({
      competitionCode: 'WC',
      dateFrom: '2026-06-11',
      dateTo: '2026-06-12',
    });
    expect(result).toEqual([]);
    expect(n).toBe(2);
  });

  test('5xx then 200 returns parsed matches after retry', async () => {
    let n = 0;
    const stub = makeStub(() => {
      n += 1;
      if (n === 1) return { status: 502, data: {} };
      return {
        status: 200,
        data: {
          matches: [
            {
              id: 1,
              status: 'SCHEDULED',
              utcDate: '2026-06-11T17:00:00Z',
              homeTeam: { id: 1, name: 'A' },
              awayTeam: { id: 2, name: 'B' },
              score: { fullTime: { home: null, away: null } },
            },
          ],
        },
      };
    });
    const client = new FootballDataClient({
      apiKey: 'k',
      axiosInstance: stub as unknown as never,
    });
    const result = await client.listCompetitionMatches({
      competitionCode: 'WC',
      dateFrom: '2026-06-11',
      dateTo: '2026-06-12',
    });
    expect(result.length).toBe(1);
    expect(n).toBe(2);
  });

  test('getMatch returns parsed match on 200', async () => {
    const stub = makeStub(() => ({
      status: 200,
      data: {
        id: 99,
        status: 'FINISHED',
        utcDate: '2026-06-11T17:00:00Z',
        homeTeam: { id: 1, name: 'A' },
        awayTeam: { id: 2, name: 'B' },
        score: { fullTime: { home: 2, away: 1 } },
      },
    }));
    const client = new FootballDataClient({
      apiKey: 'k',
      axiosInstance: stub as unknown as never,
    });
    const result = await client.getMatch(99);
    expect(result?.id).toBe(99);
    expect(stub.calls[0]!.url).toBe('/matches/99');
  });

  test('getMatch returns null on bad input', async () => {
    const stub = makeStub(() => ({ status: 200, data: {} }));
    const client = new FootballDataClient({
      apiKey: 'k',
      axiosInstance: stub as unknown as never,
    });
    expect(await client.getMatch(NaN)).toBe(null);
    expect(await client.getMatch(0)).toBe(null);
    expect(stub.calls.length).toBe(0);
  });
});
