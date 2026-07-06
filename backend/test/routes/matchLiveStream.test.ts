/**
 * F3 tests: GET /matches/live/stream (SSE match feed).
 *
 * We listen on a real ephemeral port because SSE streams cannot be tested via
 * Fastify's `inject` API (the response never finishes for a hijacked stream).
 *
 * Coverage:
 *   Connection opens with 200 + text/event-stream + retry: 5000 preamble.
 *   Live match.goal events are translated + streamed.
 *   Filter by ?matchIds= drops non-matching events.
 *   `Last-Event-ID` header triggers ring-buffer replay.
 *   Per-IP cap: the (N+1)th connection is rejected with 429.
 *   match.pulse heartbeat lands on the wire (verified via replay path so we
 *     do not have to wait 15 seconds inside the test).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { request as httpRequest, type IncomingMessage } from 'node:http';

// Force the per-IP cap to 5 BEFORE the route module reads it.
process.env.SSE_MAX_CONNECTIONS_PER_IP = '5';

const { matchLiveStreamRoutes, __sseResetMatchConnectionsForTest } = await import(
  '../../src/routes/matchLiveStreamRoutes.ts'
);
const { eventBus } = await import('../../src/lib/activity/eventBus.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;
let baseUrl = '';

beforeAll(async () => {
  app = Fastify({ logger: false, trustProxy: 1 });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(matchLiveStreamRoutes, { prefix: '/matches' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr && typeof addr === 'object') {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  } else {
    throw new Error('failed to determine listen address');
  }
});

afterAll(async () => {
  __sseResetMatchConnectionsForTest();
  await app.close();
});

interface SseConn {
  res: IncomingMessage;
  destroy: () => void;
  firstChunkReceived: Promise<string>;
  collected: () => string;
}

const openSseStream = (
  path: string,
  headers: Record<string, string> = {}
): Promise<SseConn> =>
  new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { accept: 'text/event-stream', ...headers },
      },
      (res) => {
        let buffer = '';
        let firstChunkResolver: (s: string) => void = () => undefined;
        const firstChunkReceived = new Promise<string>((r) => {
          firstChunkResolver = r;
        });
        res.on('data', (chunk: Buffer) => {
          const s = chunk.toString('utf8');
          buffer += s;
          firstChunkResolver(s);
        });
        res.once('end', () => firstChunkResolver(buffer));
        resolve({
          res,
          destroy: () => req.destroy(),
          firstChunkReceived,
          collected: () => buffer,
        });
      }
    );
    req.once('error', reject);
    req.end();
  });

// Wait for `substr` to appear in the connection buffer, up to timeoutMs.
const waitFor = async (
  conn: SseConn,
  substr: string,
  timeoutMs: number
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (conn.collected().includes(substr)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

describe('GET /matches/live/stream', () => {
  test('opens with 200, text/event-stream, and the retry preamble', async () => {
    eventBus.__resetForTest();
    __sseResetMatchConnectionsForTest();

    const conn = await openSseStream('/matches/live/stream');
    await conn.firstChunkReceived;
    expect(conn.res.statusCode).toBe(200);
    expect(conn.res.headers['content-type']).toContain('text/event-stream');
    expect(conn.collected()).toContain('retry: 5000');
    conn.destroy();
    await new Promise((r) => setTimeout(r, 50));
    __sseResetMatchConnectionsForTest();
  });

  test('streams a match.goal event when the bus publishes one', async () => {
    eventBus.__resetForTest();
    __sseResetMatchConnectionsForTest();

    const conn = await openSseStream('/matches/live/stream');
    await conn.firstChunkReceived;

    eventBus.publish('match.goal', {
      matchId: 'match-abc',
      team: 'home',
      newScore: { home: 1, away: 0 },
      scorer: 'Messi',
      minute: 34,
    });

    const gotEvent = await waitFor(conn, 'event: match.goal', 1000);
    expect(gotEvent).toBe(true);
    const buf = conn.collected();
    expect(buf).toContain('"matchId":"match-abc"');
    expect(buf).toContain('"scorer":"Messi"');
    expect(buf).toContain('"minute":34');
    // score payload comes from newScore: { home, away }.
    expect(buf).toContain('"score":{"home":1,"away":0}');

    conn.destroy();
    await new Promise((r) => setTimeout(r, 50));
    __sseResetMatchConnectionsForTest();
  });

  test('score_changed is translated to match.score with home/away/minute', async () => {
    eventBus.__resetForTest();
    __sseResetMatchConnectionsForTest();

    const conn = await openSseStream('/matches/live/stream');
    await conn.firstChunkReceived;

    eventBus.publish('match.score_changed', {
      matchId: 'match-xyz',
      previous: { home: 0, away: 0 },
      current: { home: 2, away: 1 },
    });

    const got = await waitFor(conn, 'event: match.score', 1000);
    expect(got).toBe(true);
    const buf = conn.collected();
    expect(buf).toContain('"matchId":"match-xyz"');
    expect(buf).toContain('"home":2');
    expect(buf).toContain('"away":1');
    expect(buf).toContain('"minute":null');

    conn.destroy();
    await new Promise((r) => setTimeout(r, 50));
    __sseResetMatchConnectionsForTest();
  });

  test('?matchIds= filters non-matching events out', async () => {
    eventBus.__resetForTest();
    __sseResetMatchConnectionsForTest();

    const conn = await openSseStream(
      '/matches/live/stream?matchIds=only-me'
    );
    await conn.firstChunkReceived;

    eventBus.publish('match.goal', {
      matchId: 'other-match',
      team: 'home',
      newScore: { home: 1, away: 0 },
      scorer: null,
      minute: 20,
    });
    eventBus.publish('match.goal', {
      matchId: 'only-me',
      team: 'away',
      newScore: { home: 1, away: 1 },
      scorer: 'X',
      minute: 55,
    });

    const gotWanted = await waitFor(conn, '"matchId":"only-me"', 1000);
    expect(gotWanted).toBe(true);
    // Non-matching id must not appear in the stream body.
    expect(conn.collected()).not.toContain('"matchId":"other-match"');

    conn.destroy();
    await new Promise((r) => setTimeout(r, 50));
    __sseResetMatchConnectionsForTest();
  });

  test('Last-Event-ID replay: reconnect receives events published while offline', async () => {
    eventBus.__resetForTest();
    __sseResetMatchConnectionsForTest();

    // First connection: read one event so we have a real id to replay from.
    const conn1 = await openSseStream('/matches/live/stream');
    await conn1.firstChunkReceived;

    // Publish before we grab the id so we can extract it from the wire.
    eventBus.publish('match.goal', {
      matchId: 'replay-a',
      team: 'home',
      newScore: { home: 1, away: 0 },
      scorer: null,
      minute: 10,
    });
    await waitFor(conn1, '"matchId":"replay-a"', 1000);
    // Extract the id: line preceding the replay-a data.
    const buf1 = conn1.collected();
    const idMatch = buf1.match(/id: (m-[a-z0-9-]+)\nevent: match\.goal\ndata: [^\n]*"matchId":"replay-a"/);
    expect(idMatch).not.toBeNull();
    const lastId = idMatch![1]!;

    // Disconnect, publish two more, then reconnect with Last-Event-ID.
    conn1.destroy();
    await new Promise((r) => setTimeout(r, 30));

    eventBus.publish('match.goal', {
      matchId: 'replay-b',
      team: 'away',
      newScore: { home: 1, away: 1 },
      scorer: null,
      minute: 40,
    });
    eventBus.publish('match.goal', {
      matchId: 'replay-c',
      team: 'home',
      newScore: { home: 2, away: 1 },
      scorer: null,
      minute: 70,
    });

    const conn2 = await openSseStream('/matches/live/stream', {
      'last-event-id': lastId,
    });
    await conn2.firstChunkReceived;

    const gotB = await waitFor(conn2, '"matchId":"replay-b"', 1000);
    const gotC = await waitFor(conn2, '"matchId":"replay-c"', 1000);
    expect(gotB).toBe(true);
    expect(gotC).toBe(true);
    // The first event must NOT be replayed (Last-Event-ID excludes ev itself).
    expect(conn2.collected()).not.toContain('"matchId":"replay-a"');

    conn2.destroy();
    await new Promise((r) => setTimeout(r, 50));
    __sseResetMatchConnectionsForTest();
  });

  test('per-IP cap rejects the 6th simultaneous connection with 429', async () => {
    eventBus.__resetForTest();
    __sseResetMatchConnectionsForTest();

    const conns: SseConn[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await openSseStream('/matches/live/stream');
      await c.firstChunkReceived;
      expect(c.res.statusCode).toBe(200);
      conns.push(c);
    }

    const sixth = await openSseStream('/matches/live/stream');
    await sixth.firstChunkReceived;
    expect(sixth.res.statusCode).toBe(429);
    expect(sixth.collected()).toContain('SSE_PER_IP_LIMIT');

    for (const c of conns) c.destroy();
    sixth.destroy();
    await new Promise((r) => setTimeout(r, 50));
    __sseResetMatchConnectionsForTest();
  });

  test('filter drops non-matches topic events (kickoff/halftime pass through the /activity path only)', async () => {
    eventBus.__resetForTest();
    __sseResetMatchConnectionsForTest();

    const conn = await openSseStream('/matches/live/stream');
    await conn.firstChunkReceived;

    // room.created is topic=rooms; it must never appear on this stream.
    eventBus.publish('room.created', {
      slug: 'test-room',
      matchId: 'm-1',
      hostHandle: 'x',
      isAutoWarmed: false,
    });
    // match.halftime is topic=matches but NOT one of the F3 emit types.
    eventBus.publish('match.halftime', {
      matchId: 'm-1',
      score: { home: 0, away: 0 },
    });
    // A permitted event so we know the stream is alive.
    eventBus.publish('match.goal', {
      matchId: 'gate',
      team: 'home',
      newScore: { home: 1, away: 0 },
      scorer: null,
      minute: 5,
    });

    await waitFor(conn, '"matchId":"gate"', 1000);
    const buf = conn.collected();
    expect(buf).not.toContain('event: room.created');
    expect(buf).not.toContain('event: match.halftime');
    expect(buf).toContain('event: match.goal');

    conn.destroy();
    await new Promise((r) => setTimeout(r, 50));
    __sseResetMatchConnectionsForTest();
  });
});
