/**
 * Route tests for GET /wdk/verify/:txHash (Wave 6 Tier 2 share URL).
 *
 * Uses the same in-memory Prisma stub pattern as facilitator.test.ts. No RPC
 * or real DB touched. Covers:
 *   - 404 when the txHash has no matching FacilitatorTx row
 *   - 200 JSON envelope with redacted addresses + explorer URL when found
 *   - 200 HTML variant when the caller sends `Accept: text/html`
 *   - 400 when the txHash is malformed
 *   - Room enrichment when the recipient matches an active Room
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

interface FakeFacTx {
  id: string;
  chainId: number;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  tokenAddress: string;
  nonce: string;
  validAfter: number;
  validBefore: number;
  status: string;
  submittedAt: Date;
  confirmedAt: Date | null;
  confirmedBlock: number | null;
  errorMessage: string | null;
}

interface FakeRoom {
  slug: string;
  hostHandle: string;
  hostSmartAddress: string;
  deletedAt: Date | null;
}

const facTxs: FakeFacTx[] = [];
const rooms: FakeRoom[] = [];

const fakePrisma = {
  facilitatorTx: {
    findFirst: async (args: { where: { txHash?: string } }) => {
      if (typeof args.where.txHash === 'string') {
        return facTxs.find((r) => r.txHash === args.where.txHash) ?? null;
      }
      return null;
    },
  },
  room: {
    findFirst: async (args: {
      where: { hostSmartAddress?: string; deletedAt?: null };
    }) => {
      const target = (args.where.hostSmartAddress ?? '').toLowerCase();
      return (
        rooms.find(
          (r) => r.hostSmartAddress === target && r.deletedAt === null
        ) ?? null
      );
    },
  },
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

const { wdkVerifyRoutes } = await import('../../src/routes/wdkVerifyRoutes.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;

const CONFIRMED_TX = '0x' + '11'.repeat(32);
const PENDING_TX = '0x' + '22'.repeat(32);
const HOST_SMART = '0x' + '77'.repeat(20);
const TIPPER = '0x' + '88'.repeat(20);

beforeAll(async () => {
  rooms.push({
    slug: 'curva-sud-torino',
    hostHandle: 'ultras-forever',
    hostSmartAddress: HOST_SMART,
    deletedAt: null,
  });
  facTxs.push({
    id: 'fac-1',
    chainId: 11155111,
    txHash: CONFIRMED_TX,
    fromAddress: TIPPER,
    toAddress: HOST_SMART,
    amount: '2500000', // 2.5 USDT
    tokenAddress: '0xd077a400968890eacc75cdc901f0356c943e4fdb',
    nonce: '0x' + 'ab'.repeat(32),
    validAfter: 0,
    validBefore: 9999999999,
    status: 'confirmed',
    submittedAt: new Date('2026-07-01T12:00:00.000Z'),
    confirmedAt: new Date('2026-07-01T12:00:30.000Z'),
    confirmedBlock: 8_000_001,
    errorMessage: null,
  });
  facTxs.push({
    id: 'fac-2',
    chainId: 11155111,
    txHash: PENDING_TX,
    fromAddress: TIPPER,
    toAddress: HOST_SMART,
    amount: '500000',
    tokenAddress: '0xd077a400968890eacc75cdc901f0356c943e4fdb',
    nonce: '0x' + 'cd'.repeat(32),
    validAfter: 0,
    validBefore: 9999999999,
    status: 'submitted',
    submittedAt: new Date('2026-07-01T12:05:00.000Z'),
    confirmedAt: null,
    confirmedBlock: null,
    errorMessage: null,
  });

  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(wdkVerifyRoutes, { prefix: '/wdk/verify' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  facTxs.length = 0;
  rooms.length = 0;
});

describe('GET /wdk/verify/:txHash — JSON', () => {
  test('404 when txHash is not in the FacilitatorTx table', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/wdk/verify/0x' + 'de'.repeat(32),
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('TX_NOT_FOUND');
  });

  test('400 when txHash is malformed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/wdk/verify/not-a-hash',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('200 with confirmed receipt returns full envelope + shortened addresses', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/verify/${CONFIRMED_TX}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: {
        txHash: string;
        txHashFull: string;
        explorerUrl: string | null;
        chainId: number;
        chainName: string;
        fromAddress: string;
        toAddress: string;
        amount: string;
        amountFormatted: string;
        tokenSymbol: string;
        room: string | null;
        submittedAt: string;
        confirmedAt: string | null;
        status: string;
      };
    };
    expect(body.success).toBe(true);
    // Shortened txHash contains ellipsis; full txHash preserved for click-through.
    expect(body.data.txHash.includes('...')).toBe(true);
    expect(body.data.txHashFull).toBe(CONFIRMED_TX);
    // Chain metadata resolved from chains.json.
    expect(body.data.chainId).toBe(11155111);
    expect(body.data.chainName).toBe('Sepolia');
    expect(body.data.explorerUrl).toBe(
      `https://sepolia.etherscan.io/tx/${CONFIRMED_TX}`
    );
    // Addresses redacted for screenshot safety.
    expect(body.data.fromAddress.includes('...')).toBe(true);
    expect(body.data.toAddress.includes('...')).toBe(true);
    expect(body.data.amount).toBe('2500000');
    // formatUsdt returns fixed 6-decimal representation.
    expect(body.data.amountFormatted).toBe('2.500000');
    expect(body.data.tokenSymbol).toBe('USDT');
    expect(body.data.room).toBe('curva-sud-torino');
    expect(body.data.status).toBe('confirmed');
    expect(body.data.confirmedAt).not.toBeNull();
  });

  test('200 with pending status returns confirmedAt as null', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/verify/${PENDING_TX}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { status: string; confirmedAt: string | null };
    };
    expect(body.data.status).toBe('submitted');
    expect(body.data.confirmedAt).toBeNull();
  });

  test('rate-limit headers present', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/verify/${CONFIRMED_TX}`,
    });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
  });
});

describe('GET /wdk/verify/:txHash — HTML', () => {
  test('serves HTML when Accept: text/html is sent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/verify/${CONFIRMED_TX}`,
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // Per-route CSP override present.
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(String(csp)).toContain("default-src 'none'");
    expect(String(csp)).toContain("style-src 'unsafe-inline'");
    // Body carries the amount and the explorer link.
    expect(res.body).toContain('2.500000');
    expect(res.body).toContain('USDT');
    expect(res.body).toContain(`https://sepolia.etherscan.io/tx/${CONFIRMED_TX}`);
    expect(res.body).toContain('curva-sud-torino');
  });

  test('HTML variant still 404s for unknown tx', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/wdk/verify/0x' + 'de'.repeat(32),
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
  });
});
