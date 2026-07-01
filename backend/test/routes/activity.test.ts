/**
 * Activity route tests: per-IP SSE connection cap (W2-HIGH-02) + history
 * endpoint behavior. We listen on a real ephemeral port because SSE streams
 * cannot be tested through Fastify's `inject` API (the response never finishes
 * for an open SSE stream).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { request as httpRequest, type IncomingMessage } from 'node:http';

// Force the per-IP cap to 5 BEFORE we import the route module.
process.env.SSE_MAX_CONNECTIONS_PER_IP = '5';

// Minimal Prisma stub: only the queries that GET /activity touches.
// Test can mutate `deletedRoomRows` to control the synthetic `room.deleted`
// replay path.
let deletedRoomRows: Array<{
  slug: string;
  deletedAt: Date;
  isAutoWarmed: boolean;
  expiresAt: Date;
}> = [];

let tipEventRows: Array<{
  fromAddress: string;
  toAddress: string;
  amount: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockTime: Date;
  roomId: string | null;
}> = [];

const fakePrisma = {
  tipEvent: {
    findMany: async () => tipEventRows,
  },
  room: {
    findMany: async (args: { where?: { deletedAt?: unknown; id?: unknown } }) => {
      // Batched slug lookup path used by the tips synthesis code.
      if (args.where && 'id' in args.where) return [];
      // Two call sites: created rooms (deletedAt: null) and deleted rooms
      // (deletedAt: { not: null }). Return the deletedRoomRows for the
      // second; empty for the first.
      const w = args.where?.deletedAt as { not?: null } | null | undefined;
      if (w && typeof w === 'object' && 'not' in w) {
        return deletedRoomRows;
      }
      return [];
    },
  },
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

const { activityRoutes, __sseResetConnectionsForTest } = await import(
  '../../src/routes/activityRoutes.ts'
);
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;
let baseUrl = '';

beforeAll(async () => {
  app = Fastify({ logger: false, trustProxy: 1 });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(activityRoutes, { prefix: '/activity' });
  // Listen on an ephemeral port so we can open real long-lived connections.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr && typeof addr === 'object') {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  } else {
    throw new Error('failed to determine listen address');
  }
});

afterAll(async () => {
  __sseResetConnectionsForTest();
  await app.close();
});

interface SseConn {
  res: IncomingMessage;
  destroy: () => void;
  firstChunkReceived: Promise<void>;
}

const openSseStream = (path: string): Promise<SseConn> =>
  new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { accept: 'text/event-stream' },
      },
      (res) => {
        let firstChunkResolver: () => void = () => undefined;
        const firstChunkReceived = new Promise<void>((r) => {
          firstChunkResolver = r;
        });
        res.once('data', () => firstChunkResolver());
        // Some streams may end before any data; treat end as "first chunk".
        res.once('end', () => firstChunkResolver());
        // Swallow further data so node doesn't buffer indefinitely.
        res.on('data', () => undefined);
        resolve({
          res,
          destroy: () => req.destroy(),
          firstChunkReceived,
        });
      }
    );
    req.once('error', reject);
    req.end();
  });

describe('GET /activity/stream — per-IP connection cap', () => {
  test('rejects the 6th simultaneous connection from a single IP with 429', async () => {
    __sseResetConnectionsForTest();

    const openConns: SseConn[] = [];
    // Open exactly SSE_MAX_CONNECTIONS_PER_IP (5) accepted streams.
    for (let i = 0; i < 5; i++) {
      const c = await openSseStream('/activity/stream');
      // Wait for the first frame so the server has fully registered the slot.
      await c.firstChunkReceived;
      expect(c.res.statusCode).toBe(200);
      openConns.push(c);
    }

    // The 6th must be rejected with 429 and the SSE_PER_IP_LIMIT error frame.
    const sixth = await openSseStream('/activity/stream');
    await sixth.firstChunkReceived;
    expect(sixth.res.statusCode).toBe(429);

    // Cleanup so subsequent tests get a fresh tracker.
    for (const c of openConns) c.destroy();
    sixth.destroy();
    // Give the server a tick to process the close events.
    await new Promise((r) => setTimeout(r, 50));
    __sseResetConnectionsForTest();
  });
});

describe('GET /activity — history endpoint', () => {
  test('returns the standard envelope and omittedTopics', async () => {
    const res = await app.inject({ method: 'GET', url: '/activity' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { events: unknown[]; omittedTopics: string[] };
    };
    expect(Array.isArray(body.data.events)).toBe(true);
    expect(Array.isArray(body.data.omittedTopics)).toBe(true);
  });

  test('synthDeleted infers reason="expired" when deletedAt > expiresAt (CODE_REVIEW W2 nice-to-have)', async () => {
    deletedRoomRows = [
      {
        slug: 'expired-room',
        // deletedAt is AFTER expiresAt -> expired
        deletedAt: new Date('2026-06-30T12:00:00Z'),
        isAutoWarmed: false,
        expiresAt: new Date('2026-06-30T11:00:00Z'),
      },
      {
        slug: 'auto-cleanup-room',
        // deletedAt is BEFORE expiresAt + isAutoWarmed -> auto-cleanup
        deletedAt: new Date('2026-06-30T10:00:00Z'),
        isAutoWarmed: true,
        expiresAt: new Date('2026-06-30T11:00:00Z'),
      },
      {
        slug: 'host-deleted-room',
        // deletedAt is BEFORE expiresAt + NOT auto-warmed -> host
        deletedAt: new Date('2026-06-30T10:00:00Z'),
        isAutoWarmed: false,
        expiresAt: new Date('2026-06-30T11:00:00Z'),
      },
    ];

    const res = await app.inject({ method: 'GET', url: '/activity?topics=rooms' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { events: Array<{ id: string; payload: { reason?: string } }> };
    };
    const byId = new Map(body.data.events.map((e) => [e.id, e]));
    expect(byId.get('r-expired-room-d')?.payload.reason).toBe('expired');
    expect(byId.get('r-auto-cleanup-room-d')?.payload.reason).toBe('auto-cleanup');
    expect(byId.get('r-host-deleted-room-d')?.payload.reason).toBe('host');

    deletedRoomRows = [];
  });

  test('tip.confirmed payload.txHash is redacted, never full 66 chars (SECURITY_AUDIT MED-02)', async () => {
    // Reset the eventBus so in-memory tip.confirmed events published by prior
    // test files (e.g. dashboard.test.ts, eventBus.test.ts) do not bleed in.
    const { eventBus } = await import('../../src/lib/activity/eventBus.ts');
    eventBus.__resetForTest();

    const FULL = '0x' + 'cd'.repeat(32);
    tipEventRows = [
      {
        fromAddress: '0x' + '11'.repeat(20),
        toAddress: '0x' + '22'.repeat(20),
        amount: '1000000',
        txHash: FULL,
        logIndex: 0,
        blockNumber: 100,
        blockTime: new Date('2026-06-30T12:00:00Z'),
        roomId: null,
      },
    ];

    const res = await app.inject({ method: 'GET', url: '/activity?topics=tips&limit=5' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { events: Array<{ type: string; payload: { txHash?: string } }> };
    };
    const tipEvents = body.data.events.filter((e) => e.type === 'tip.confirmed');
    expect(tipEvents.length).toBeGreaterThan(0);
    for (const ev of tipEvents) {
      expect(ev.payload.txHash).toBeDefined();
      expect(ev.payload.txHash).not.toBe(FULL);
      // shortenAddress(FULL, 10, 6) -> '0x' + 8 hex + '...' + 6 hex
      expect(ev.payload.txHash).toMatch(/^0x[a-fA-F0-9]{8}\.{3}[a-fA-F0-9]{6}$/);
    }

    tipEventRows = [];
  });

  test('omittedTopics does NOT include seeder when buffered seeder events exist (CODE_REVIEW W2 #4)', async () => {
    const { eventBus } = await import('../../src/lib/activity/eventBus.ts');
    // The eventBus singleton is shared across test files. Reset its buffer so
    // this test is not contaminated by `match.starting_soon` events emitted
    // by matchAutoWarmWorker.test.ts.
    eventBus.__resetForTest();
    eventBus.publish('seeder.peers_changed', {
      slug: 'demo-room',
      peerCount: 3,
      lifetimeBytes: 0,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/activity?topics=seeder,matches',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { events: Array<{ topic: string }>; omittedTopics: string[] };
    };
    // The buffer has a seeder event, so omittedTopics must NOT mark it as
    // missing. `matches` has no buffered event so it should still be omitted.
    expect(body.data.omittedTopics).not.toContain('seeder');
    expect(body.data.omittedTopics).toContain('matches');
  });
});
