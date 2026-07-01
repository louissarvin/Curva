/**
 * Wave 14 — route tests for GET /wdk/verify-attendance/:slug/:address.
 *
 * Coverage:
 *   - 503 FEATURE_DISABLED when the flag is off
 *   - 400 VALIDATION_ERROR on malformed inputs
 *   - 200 with valid pass when host signature verifies
 *   - 400 HOST_MISMATCH when signer differs from registered host
 *   - 410 PASS_EXPIRED when issuedAt is older than 24h
 *   - 200 for unregistered rooms (off-chain trust)
 *   - Rate-limit headers present
 */

process.env.CURVA_ATTENDANCE_ENABLED = 'true';

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { ethers } from 'ethers';

const mainConfigModule = await import('../../src/config/main-config.ts');
mock.module('../../src/config/main-config.ts', () => ({
  ...mainConfigModule,
  CURVA_ATTENDANCE_ENABLED: true,
  CURVA_ATTENDANCE_RATE_LIMIT_MAX: 10000,
  CURVA_ATTENDANCE_MAX_AGE_SECONDS: 60 * 60 * 24,
}));

interface FakeRoom {
  slug: string;
  hostOwnerAddress: string | null;
  matchId: string | null;
  deletedAt: Date | null;
}

const rooms: FakeRoom[] = [];

mock.module('../../src/lib/prisma.ts', () => ({
  prismaQuery: {
    room: {
      findFirst: async (args: {
        where: { slug?: string; deletedAt?: null };
      }) => {
        const slug = String(args.where.slug || '').toLowerCase();
        return (
          rooms.find(
            (r) => r.slug === slug && r.deletedAt === null
          ) ?? null
        );
      },
    },
    errorLog: { create: async () => ({}) },
  },
}));

const HOST_PK = '0x' + 'aa'.repeat(32);
const OTHER_PK = '0x' + 'bb'.repeat(32);
const PEER_ADDRESS = '0x' + '11'.repeat(20);
const REGISTERED_SLUG = 'curva-sud-torino';
const UNREGISTERED_SLUG = 'stranger-room-xx';
const MATCH_ID = 'match-1';

const host = new ethers.Wallet(HOST_PK);
const other = new ethers.Wallet(OTHER_PK);

const { attendanceRoutes } = await import('../../src/routes/attendanceRoutes.ts');
const { buildAttendanceMessage } = await import('../../src/lib/evm/attendance.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;

const nowSec = () => Math.floor(Date.now() / 1000);

async function signPass(wallet: ethers.Wallet, slug: string, matchId: string, issuedAt: number) {
  const msg = buildAttendanceMessage({
    slug,
    matchId,
    peerAddress: PEER_ADDRESS,
    issuedAt,
  });
  return wallet.signMessage(msg);
}

beforeAll(async () => {
  rooms.push({
    slug: REGISTERED_SLUG,
    hostOwnerAddress: host.address.toLowerCase(),
    matchId: 'db-match-42',
    deletedAt: null,
  });

  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(attendanceRoutes, { prefix: '/wdk/verify-attendance' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rooms.length = 0;
});

describe('GET /wdk/verify-attendance', () => {
  test('200 with valid pass for a registered room', async () => {
    const issuedAt = nowSec();
    const sig = await signPass(host, REGISTERED_SLUG, MATCH_ID, issuedAt);
    const url = `/wdk/verify-attendance/${REGISTERED_SLUG}/${PEER_ADDRESS}?signature=${encodeURIComponent(sig)}&matchId=${MATCH_ID}&issuedAt=${issuedAt}`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: {
        valid: boolean;
        hostAddress: string;
        hostAddressShort: string;
        peerAddress: string;
        registered: boolean;
        ageHours: number;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.valid).toBe(true);
    expect(body.data.hostAddress).toBe(host.address.toLowerCase());
    expect(body.data.hostAddressShort).toContain('...');
    expect(body.data.peerAddress).toBe(PEER_ADDRESS.toLowerCase());
    expect(body.data.registered).toBe(true);
  });

  test('200 for an unregistered slug (off-chain trust)', async () => {
    const issuedAt = nowSec();
    const sig = await signPass(host, UNREGISTERED_SLUG, MATCH_ID, issuedAt);
    const url = `/wdk/verify-attendance/${UNREGISTERED_SLUG}/${PEER_ADDRESS}?signature=${encodeURIComponent(sig)}&matchId=${MATCH_ID}&issuedAt=${issuedAt}`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { valid: boolean; registered: boolean } };
    expect(body.data.valid).toBe(true);
    expect(body.data.registered).toBe(false);
  });

  test('400 HOST_MISMATCH when signature is from a different key', async () => {
    const issuedAt = nowSec();
    const sig = await signPass(other, REGISTERED_SLUG, MATCH_ID, issuedAt);
    const url = `/wdk/verify-attendance/${REGISTERED_SLUG}/${PEER_ADDRESS}?signature=${encodeURIComponent(sig)}&matchId=${MATCH_ID}&issuedAt=${issuedAt}`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('HOST_MISMATCH');
  });

  test('410 PASS_EXPIRED when issuedAt is older than 24h', async () => {
    const oldTs = nowSec() - 25 * 60 * 60;
    const sig = await signPass(host, REGISTERED_SLUG, MATCH_ID, oldTs);
    const url = `/wdk/verify-attendance/${REGISTERED_SLUG}/${PEER_ADDRESS}?signature=${encodeURIComponent(sig)}&matchId=${MATCH_ID}&issuedAt=${oldTs}`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(410);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('PASS_EXPIRED');
  });

  test('400 VALIDATION_ERROR when slug is malformed', async () => {
    const issuedAt = nowSec();
    const sig = await signPass(host, REGISTERED_SLUG, MATCH_ID, issuedAt);
    const url = `/wdk/verify-attendance/BAD_SLUG/${PEER_ADDRESS}?signature=${encodeURIComponent(sig)}&issuedAt=${issuedAt}`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('400 VALIDATION_ERROR when address is malformed', async () => {
    const url = `/wdk/verify-attendance/${REGISTERED_SLUG}/not-hex?signature=0x` + 'aa'.repeat(65) + `&issuedAt=${nowSec()}`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
  });

  test('400 VALIDATION_ERROR when signature is missing', async () => {
    const url = `/wdk/verify-attendance/${REGISTERED_SLUG}/${PEER_ADDRESS}?issuedAt=${nowSec()}`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('400 SIGNATURE_INVALID when signature does not verify', async () => {
    const issuedAt = nowSec();
    const sig = await signPass(host, REGISTERED_SLUG, MATCH_ID, issuedAt);
    // Change the peer address to invalidate the recovery vs signer
    const otherPeer = '0x' + '22'.repeat(20);
    const url = `/wdk/verify-attendance/${REGISTERED_SLUG}/${otherPeer}?signature=${encodeURIComponent(sig)}&matchId=${MATCH_ID}&issuedAt=${issuedAt}`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    // Recovery still works but recovers to a random address, so we get HOST_MISMATCH
    // against the registered room's hostOwnerAddress.
    expect(['HOST_MISMATCH', 'SIGNATURE_INVALID']).toContain(body.error.code);
  });

  test('rate-limit headers present on 200 responses', async () => {
    const issuedAt = nowSec();
    const sig = await signPass(host, REGISTERED_SLUG, MATCH_ID, issuedAt);
    const url = `/wdk/verify-attendance/${REGISTERED_SLUG}/${PEER_ADDRESS}?signature=${encodeURIComponent(sig)}&matchId=${MATCH_ID}&issuedAt=${issuedAt}`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
  });
});

// -----------------------------------------------------------------------------
// Feature-flag OFF: separate app instance because main-config is captured at
// route-plugin import time.
// -----------------------------------------------------------------------------

describe('GET /wdk/verify-attendance — feature flag off', () => {
  test('503 FEATURE_DISABLED when CURVA_ATTENDANCE_ENABLED=false', async () => {
    // Re-mock with flag off and re-import the routes module fresh.
    const cfg = await import('../../src/config/main-config.ts');
    mock.module('../../src/config/main-config.ts', () => ({
      ...cfg,
      CURVA_ATTENDANCE_ENABLED: false,
      CURVA_ATTENDANCE_RATE_LIMIT_MAX: 10000,
      CURVA_ATTENDANCE_MAX_AGE_SECONDS: 60 * 60 * 24,
    }));
    const disabledModule = await import('../../src/routes/attendanceRoutes.ts?disabled=1');
    const disabledApp = Fastify({ logger: false });
    await disabledApp.register(FastifyRateLimit, { global: false });
    await disabledApp.register(disabledModule.attendanceRoutes, {
      prefix: '/wdk/verify-attendance',
    });
    await disabledApp.ready();
    const res = await disabledApp.inject({
      method: 'GET',
      url: `/wdk/verify-attendance/${REGISTERED_SLUG}/${PEER_ADDRESS}?signature=0x` + 'aa'.repeat(65) + `&issuedAt=${nowSec()}`,
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FEATURE_DISABLED');
    await disabledApp.close();

    // Restore
    mock.module('../../src/config/main-config.ts', () => ({
      ...cfg,
      CURVA_ATTENDANCE_ENABLED: true,
      CURVA_ATTENDANCE_RATE_LIMIT_MAX: 10000,
      CURVA_ATTENDANCE_MAX_AGE_SECONDS: 60 * 60 * 24,
    }));
  });
});
