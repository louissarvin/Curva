/**
 * Route tests for /rooms with a stub Prisma client.
 * Verifies validation, slug-conflict handling, and the signature-challenge flow.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { ethers } from 'ethers';

const fakeMatch = {
  id: 'c' + 'a'.repeat(24),
  externalId: 100001,
  kickoffUtc: new Date('2026-06-11T17:00:00.000Z'),
  stage: 'group',
  status: 'scheduled',
};

const rooms = new Map<string, {
  id: string;
  slug: string;
  matchId: string;
  hostHandle: string;
  hostSmartAddress: string;
  hostOwnerAddress: string | null;
  pearLink: string | null;
  expiresAt: Date;
  deletedAt: Date | null;
  createdAt: Date;
  visibility: string;
}>();

const fakePrisma = {
  match: {
    findUnique: async (args: { where: { id: string } }) => (args.where.id === fakeMatch.id ? fakeMatch : null),
  },
  room: {
    findUnique: async (args: { where: { slug: string }; include?: unknown; select?: unknown }) => {
      const r = rooms.get(args.where.slug);
      if (!r) return null;
      if (args.include) {
        return { ...r, match: { id: fakeMatch.id, kickoffUtc: fakeMatch.kickoffUtc, stage: fakeMatch.stage, status: fakeMatch.status, homeTeam: {}, awayTeam: {} } };
      }
      return r;
    },
    findMany: async (args?: { where?: Record<string, unknown> }) => {
      const all = Array.from(rooms.values());
      const w = args?.where || {};
      return all.filter((r) => {
        if (w.visibility && r.visibility !== w.visibility) return false;
        return true;
      });
    },
    count: async (args?: { where?: Record<string, unknown> }) => {
      const w = args?.where || {};
      let n = 0;
      for (const r of rooms.values()) {
        if (w.visibility && r.visibility !== w.visibility) continue;
        n++;
      }
      return n;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const slug = args.data.slug as string;
      if (rooms.has(slug)) {
        const err = new Error('Unique constraint violation') as Error & {
          code: string;
          meta: { target: string[] };
        };
        err.code = 'P2002';
        err.meta = { target: ['slug'] };
        throw err;
      }
      const row = {
        id: 'c' + 'r'.repeat(24),
        slug,
        matchId: args.data.matchId as string,
        hostHandle: args.data.hostHandle as string,
        hostSmartAddress: args.data.hostSmartAddress as string,
        hostOwnerAddress: (args.data.hostOwnerAddress as string | null) ?? null,
        pearLink: (args.data.pearLink as string | null) ?? null,
        expiresAt: args.data.expiresAt as Date,
        deletedAt: null,
        createdAt: new Date(),
        visibility: ((args.data.visibility as string | undefined) ?? 'private'),
      };
      rooms.set(slug, row);
      return row;
    },
    update: async (args: { where: { slug: string }; data: { deletedAt?: Date } }) => {
      const r = rooms.get(args.where.slug);
      if (!r) throw new Error('not found');
      if (args.data.deletedAt) r.deletedAt = args.data.deletedAt;
      return r;
    },
  },
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

const { roomRoutes } = await import('../../src/routes/roomRoutes.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;
const ownerWallet = ethers.Wallet.createRandom();
const smartAccountAddress = ethers.Wallet.createRandom().address; // distinct from owner
const validSlug = 'arg-vs-ita-r16';

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(roomRoutes, { prefix: '/rooms' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rooms.clear();
});

describe('POST /rooms', () => {
  test('rejects missing fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: { slug: validSlug },
    });
    expect(res.statusCode).toBe(400);
  });

  test('rejects invalid slug', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: {
        slug: 'BAD SLUG!',
        matchId: fakeMatch.id,
        hostHandle: 'host',
        hostSmartAddress: smartAccountAddress,
        hostOwnerAddress: ownerWallet.address,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  test('rejects invalid smart address', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: {
        slug: 'good-slug-1',
        matchId: fakeMatch.id,
        hostHandle: 'host',
        hostSmartAddress: 'not-an-address',
        hostOwnerAddress: ownerWallet.address,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  test('rejects invalid owner address', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: {
        slug: 'good-slug-2',
        matchId: fakeMatch.id,
        hostHandle: 'host',
        hostSmartAddress: smartAccountAddress,
        hostOwnerAddress: 'not-an-address',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  test('rejects unknown matchId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: {
        slug: 'good-slug-3',
        matchId: 'c' + 'z'.repeat(24),
        hostHandle: 'host',
        hostSmartAddress: smartAccountAddress,
        hostOwnerAddress: ownerWallet.address,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  test('creates a room', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: {
        slug: validSlug,
        matchId: fakeMatch.id,
        hostHandle: 'host',
        hostSmartAddress: smartAccountAddress,
        hostOwnerAddress: ownerWallet.address,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      data: { room: { slug: string; hostSmartAddress: string; hostOwnerAddress: string } };
    };
    expect(body.data.room.slug).toBe(validSlug);
    expect(body.data.room.hostSmartAddress).toBe(smartAccountAddress.toLowerCase());
    expect(body.data.room.hostOwnerAddress).toBe(ownerWallet.address.toLowerCase());
  });

  test('rejects reserved auto- slug prefix (W2-HIGH-01)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: {
        slug: 'auto-cmatch1234567890abcdef',
        matchId: fakeMatch.id,
        hostHandle: 'host',
        hostSmartAddress: smartAccountAddress,
        hostOwnerAddress: ownerWallet.address,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('RESERVED_SLUG_PREFIX');
  });

  test('rejects duplicate slug', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: {
        slug: validSlug,
        matchId: fakeMatch.id,
        hostHandle: 'host',
        hostSmartAddress: smartAccountAddress,
        hostOwnerAddress: ownerWallet.address,
      },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('GET /rooms/:slug/delete-challenge', () => {
  test('returns sign payload', async () => {
    const res = await app.inject({ method: 'GET', url: `/rooms/${validSlug}/delete-challenge` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { challenge: string; signPayload: string; expiresIn: number } };
    expect(body.data.challenge.length).toBeGreaterThanOrEqual(40);
    expect(body.data.signPayload).toBe(`curva-delete:${validSlug}:${body.data.challenge}`);
    expect(body.data.expiresIn).toBeGreaterThan(0);
  });

  test('404 on unknown slug', async () => {
    const res = await app.inject({ method: 'GET', url: '/rooms/no-such-room/delete-challenge' });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /rooms/:slug', () => {
  test('rejects without signature', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/rooms/${validSlug}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  test('rejects with wrong signature', async () => {
    const chalRes = await app.inject({ method: 'GET', url: `/rooms/${validSlug}/delete-challenge` });
    const { challenge } = (chalRes.json() as { data: { challenge: string } }).data;
    const otherWallet = ethers.Wallet.createRandom();
    const sig = await otherWallet.signMessage(`curva-delete:${validSlug}:${challenge}`);

    const res = await app.inject({
      method: 'DELETE',
      url: `/rooms/${validSlug}`,
      payload: { challenge, signature: sig },
    });
    expect(res.statusCode).toBe(401);
  });

  test('accepts correct signature from hostOwnerAddress', async () => {
    const chalRes = await app.inject({ method: 'GET', url: `/rooms/${validSlug}/delete-challenge` });
    const { challenge } = (chalRes.json() as { data: { challenge: string } }).data;
    // Signed by the owner EOA, NOT the smart-account address. This is the
    // contract the audit fix established (CRIT-01b).
    const sig = await ownerWallet.signMessage(`curva-delete:${validSlug}:${challenge}`);

    const res = await app.inject({
      method: 'DELETE',
      url: `/rooms/${validSlug}`,
      payload: { challenge, signature: sig },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { deleted: boolean } };
    expect(body.data.deleted).toBe(true);
  });

  test('replay attempt fails (challenge already consumed)', async () => {
    // Need to re-create the room first since the previous test soft-deleted it.
    rooms.delete(validSlug);
    await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: {
        slug: validSlug,
        matchId: fakeMatch.id,
        hostHandle: 'host',
        hostSmartAddress: smartAccountAddress,
        hostOwnerAddress: ownerWallet.address,
      },
    });
    const chalRes = await app.inject({ method: 'GET', url: `/rooms/${validSlug}/delete-challenge` });
    const { challenge } = (chalRes.json() as { data: { challenge: string } }).data;
    const sig = await ownerWallet.signMessage(`curva-delete:${validSlug}:${challenge}`);

    const first = await app.inject({
      method: 'DELETE',
      url: `/rooms/${validSlug}`,
      payload: { challenge, signature: sig },
    });
    expect(first.statusCode).toBe(200);

    // Replay same signature+challenge -> rejected (room is soft-deleted now, returns 404)
    const replay = await app.inject({
      method: 'DELETE',
      url: `/rooms/${validSlug}`,
      payload: { challenge, signature: sig },
    });
    expect([401, 404]).toContain(replay.statusCode);
  });
});

// TIER 4: Autopass spectator tier visibility.
describe('Autopass visibility field', () => {
  test('POST /rooms defaults visibility to private when unset', async () => {
    rooms.delete('vis-default-1');
    const res = await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: {
        slug: 'vis-default-1',
        matchId: fakeMatch.id,
        hostHandle: 'host',
        hostSmartAddress: smartAccountAddress,
        hostOwnerAddress: ownerWallet.address,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { room: { visibility: string } } };
    expect(body.data.room.visibility).toBe('private');
  });

  test('POST /rooms accepts and persists visibility: public', async () => {
    rooms.delete('vis-public-1');
    const res = await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: {
        slug: 'vis-public-1',
        matchId: fakeMatch.id,
        hostHandle: 'host',
        hostSmartAddress: smartAccountAddress,
        hostOwnerAddress: ownerWallet.address,
        visibility: 'public',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { room: { slug: string; visibility: string } } };
    expect(body.data.room.visibility).toBe('public');
    expect(rooms.get('vis-public-1')?.visibility).toBe('public');
  });

  test('POST /rooms rejects malformed visibility values', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: {
        slug: 'vis-bad-1',
        matchId: fakeMatch.id,
        hostHandle: 'host',
        hostSmartAddress: smartAccountAddress,
        hostOwnerAddress: ownerWallet.address,
        visibility: 'unlisted',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('GET /rooms?visibility=public only returns public rooms', async () => {
    // Ensure both categories present.
    rooms.delete('vis-pub-2');
    rooms.delete('vis-priv-2');
    await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: {
        slug: 'vis-pub-2',
        matchId: fakeMatch.id,
        hostHandle: 'host',
        hostSmartAddress: smartAccountAddress,
        hostOwnerAddress: ownerWallet.address,
        visibility: 'public',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/rooms',
      payload: {
        slug: 'vis-priv-2',
        matchId: fakeMatch.id,
        hostHandle: 'host',
        hostSmartAddress: smartAccountAddress,
        hostOwnerAddress: ownerWallet.address,
        visibility: 'private',
      },
    });
    // Bypass the activeOnly filter (the fake findMany ignores it, so the
    // in-memory list contains every row; we only test the visibility filter).
    const res = await app.inject({
      method: 'GET',
      url: '/rooms?visibility=public&activeOnly=false',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { rooms: Array<{ slug: string; visibility: string }> };
    };
    const slugs = body.data.rooms.map((r) => r.slug);
    expect(slugs).toContain('vis-pub-2');
    expect(slugs).not.toContain('vis-priv-2');
    for (const r of body.data.rooms) {
      expect(r.visibility).toBe('public');
    }
  });

  test('GET /rooms?visibility=invalid returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/rooms?visibility=unlisted',
    });
    expect(res.statusCode).toBe(400);
  });
});
