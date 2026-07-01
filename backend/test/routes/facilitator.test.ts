/**
 * F11 route tests for /wdk/relay/*.
 *
 * The facilitator module snapshots RELAY_SPONSOR_PK/ENABLED at import time,
 * so we import the routes, use __setSponsorForTest to inject a stub sponsor,
 * mock the prisma client to serve FacilitatorTx / Room queries, and mock
 * submitEip3009Relay to avoid real RPC calls.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { ethers } from 'ethers';

// -----------------------------------------------------------------------------
// Prisma stub — implements only the queries the facilitator route touches.
// -----------------------------------------------------------------------------

interface FakeRoom {
  slug: string;
  hostSmartAddress: string;
  deletedAt: Date | null;
}

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

const rooms: FakeRoom[] = [];
const facTxs: FakeFacTx[] = [];

const fakePrisma = {
  room: {
    findFirst: async (args: { where: { hostSmartAddress?: string; deletedAt?: null } }) => {
      const target = (args.where.hostSmartAddress ?? '').toLowerCase();
      return rooms.find((r) => r.hostSmartAddress === target && r.deletedAt === null) ?? null;
    },
  },
  facilitatorTx: {
    findUnique: async (args: {
      where: { chainId_nonce?: { chainId: number; nonce: string }; txHash?: string };
    }) => {
      if (args.where.chainId_nonce) {
        const { chainId, nonce } = args.where.chainId_nonce;
        return facTxs.find((r) => r.chainId === chainId && r.nonce === nonce) ?? null;
      }
      if (args.where.txHash !== undefined) {
        return facTxs.find((r) => r.txHash === args.where.txHash) ?? null;
      }
      return null;
    },
    create: async (args: { data: Partial<FakeFacTx> }) => {
      const collision = facTxs.find(
        (r) => r.chainId === args.data.chainId && r.nonce === args.data.nonce
      );
      if (collision) {
        const err: Error & { code?: string } = new Error('unique');
        err.code = 'P2002';
        throw err;
      }
      const row: FakeFacTx = {
        id: `fac-${facTxs.length + 1}`,
        chainId: args.data.chainId as number,
        txHash: args.data.txHash as string,
        fromAddress: args.data.fromAddress as string,
        toAddress: args.data.toAddress as string,
        amount: args.data.amount as string,
        tokenAddress: args.data.tokenAddress as string,
        nonce: args.data.nonce as string,
        validAfter: args.data.validAfter as number,
        validBefore: args.data.validBefore as number,
        status: (args.data.status as string) ?? 'pending',
        submittedAt: (args.data.submittedAt as Date) ?? new Date(),
        confirmedAt: null,
        confirmedBlock: null,
        errorMessage: null,
      };
      facTxs.push(row);
      return row;
    },
    update: async (args: { where: { id: string }; data: Partial<FakeFacTx> }) => {
      const row = facTxs.find((r) => r.id === args.where.id);
      if (!row) {
        const err: Error & { code?: string } = new Error('not found');
        err.code = 'P2025';
        throw err;
      }
      Object.assign(row, args.data);
      return row;
    },
  },
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

// -----------------------------------------------------------------------------
// Stub the EIP-712 domain lookup so no RPC roundtrip happens.
// -----------------------------------------------------------------------------

const DOMAIN = {
  name: 'USDT',
  version: '1',
  chainId: 11155111,
  verifyingContract: '0xd077a400968890eacc75cdc901f0356c943e4fdb',
};

const { EIP3009_TYPES } = await import('../../src/lib/evm/eip3009.ts');
const eip3009Module = await import('../../src/lib/evm/eip3009.ts');
const originalRecover = eip3009Module.recoverEip3009Signer;

mock.module('../../src/lib/evm/eip3009.ts', () => ({
  ...eip3009Module,
  fetchEip3009Domain: async () => DOMAIN,
  recoverEip3009Signer: originalRecover,
  EIP3009_TYPES,
}));

// -----------------------------------------------------------------------------
// Stub facilitator submit so we don't need a live RPC. Keep the real disabled/
// enabled state helpers (they read from the module-level snapshot).
// -----------------------------------------------------------------------------

const facilitatorModule = await import('../../src/lib/evm/facilitator.ts');
const { __setSponsorForTest, __resetBalanceCacheForTest } = facilitatorModule;

let stubSubmitTxHash = '0x' + 'ab'.repeat(32);
let stubSubmitError: Error | null = null;
let stubSubmitCallCount = 0;

mock.module('../../src/lib/evm/facilitator.ts', () => ({
  ...facilitatorModule,
  submitEip3009Relay: async () => {
    stubSubmitCallCount++;
    if (stubSubmitError) throw stubSubmitError;
    return { txHash: stubSubmitTxHash, sponsorAddress: '0xsponsor' };
  },
}));

// -----------------------------------------------------------------------------
// Import routes AFTER the mocks are in place.
// -----------------------------------------------------------------------------

const { facilitatorRoutes } = await import('../../src/routes/facilitatorRoutes.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;
let signerWallet: ethers.HDNodeWallet;
const hostAddress = '0x' + '77'.repeat(20);

const signAuthorization = async (
  wallet: ethers.HDNodeWallet,
  message: {
    from: string;
    to: string;
    value: string;
    validAfter: number;
    validBefore: number;
    nonce: string;
  }
) => {
  const raw = await wallet.signTypedData(
    DOMAIN,
    EIP3009_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    message
  );
  const parsed = ethers.Signature.from(raw);
  return { v: parsed.v, r: parsed.r, s: parsed.s };
};

const buildPayload = async (overrides: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const from = signerWallet.address.toLowerCase();
  const message = {
    from,
    to: hostAddress,
    value: '1000000',
    validAfter: 0,
    validBefore: now + 3600,
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const sig = await signAuthorization(signerWallet, message);
  return {
    chainId: 11155111,
    tokenAddress: DOMAIN.verifyingContract,
    ...message,
    ...sig,
    ...overrides,
  };
};

beforeAll(async () => {
  signerWallet = ethers.Wallet.createRandom();
  rooms.push({ slug: 'test-room', hostSmartAddress: hostAddress, deletedAt: null });
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(facilitatorRoutes, { prefix: '/wdk/relay' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  __setSponsorForTest(null);
  __resetBalanceCacheForTest();
  rooms.length = 0;
  facTxs.length = 0;
});

describe('POST /wdk/relay/eip3009 — facilitator disabled by default', () => {
  test('returns 503 FACILITATOR_DISABLED when facilitator is off', async () => {
    __setSponsorForTest(null);
    const payload = await buildPayload();
    const res = await app.inject({
      method: 'POST',
      url: '/wdk/relay/eip3009',
      payload,
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as {
      error: { code: string };
      data: { enabled: boolean; requiredEnv: string[] };
    };
    expect(body.error.code).toBe('FACILITATOR_DISABLED');
    expect(body.data.enabled).toBe(false);
    expect(body.data.requiredEnv).toContain('RELAY_SPONSOR_PK');
  });

  test('/status returns 503 when disabled', async () => {
    __setSponsorForTest(null);
    const res = await app.inject({
      method: 'GET',
      url: '/wdk/relay/status/0x' + 'ab'.repeat(32),
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FACILITATOR_DISABLED');
  });

  test('/health returns 503 when disabled', async () => {
    __setSponsorForTest(null);
    const res = await app.inject({ method: 'GET', url: '/wdk/relay/health' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FACILITATOR_DISABLED');
  });
});

describe('POST /wdk/relay/eip3009 — facilitator enabled', () => {
  beforeAll(() => {
    // Inject a stub sponsor to flip the facilitator to enabled.
    __setSponsorForTest(new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32))));
  });

  test('400 on missing required field (chainId)', async () => {
    const payload = await buildPayload();
    delete (payload as Record<string, unknown>).chainId;
    const res = await app.inject({
      method: 'POST',
      url: '/wdk/relay/eip3009',
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  test('400 on bad EVM address in from', async () => {
    const payload = await buildPayload({ from: 'not-an-address' });
    const res = await app.inject({
      method: 'POST',
      url: '/wdk/relay/eip3009',
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  test('400 when amount exceeds cap', async () => {
    // 200 USDT (base units) — cap is 100 USDT in test.
    const payload = await buildPayload({ value: '200000000' });
    const res = await app.inject({
      method: 'POST',
      url: '/wdk/relay/eip3009',
      payload,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('AMOUNT_EXCEEDS_CAP');
  });

  test('400 when token not allowed', async () => {
    const payload = await buildPayload({
      tokenAddress: '0x0000000000000000000000000000000000000001',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/wdk/relay/eip3009',
      payload,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('TOKEN_NOT_ALLOWED');
  });

  test('400 when recipient is not a registered host', async () => {
    const payload = await buildPayload({ to: '0x' + '99'.repeat(20) });
    // Re-sign with the new `to` so the signature is otherwise valid.
    const resigned = await signAuthorization(signerWallet, {
      from: (payload as Record<string, unknown>).from as string,
      to: (payload as Record<string, unknown>).to as string,
      value: (payload as Record<string, unknown>).value as string,
      validAfter: (payload as Record<string, unknown>).validAfter as number,
      validBefore: (payload as Record<string, unknown>).validBefore as number,
      nonce: (payload as Record<string, unknown>).nonce as string,
    });
    Object.assign(payload, resigned);
    const res = await app.inject({
      method: 'POST',
      url: '/wdk/relay/eip3009',
      payload,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('HOST_NOT_REGISTERED');
  });

  test('400 on invalid signature (wrong signer)', async () => {
    const payload = await buildPayload();
    // Overwrite the signature with one from a different wallet.
    const other = ethers.Wallet.createRandom();
    const badSig = await signAuthorization(other, {
      from: (payload as Record<string, unknown>).from as string,
      to: (payload as Record<string, unknown>).to as string,
      value: (payload as Record<string, unknown>).value as string,
      validAfter: (payload as Record<string, unknown>).validAfter as number,
      validBefore: (payload as Record<string, unknown>).validBefore as number,
      nonce: (payload as Record<string, unknown>).nonce as string,
    });
    Object.assign(payload, badSig);
    const res = await app.inject({
      method: 'POST',
      url: '/wdk/relay/eip3009',
      payload,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_SIGNATURE');
  });

  test('happy path: 200 with txHash + reservationId returned', async () => {
    stubSubmitTxHash = '0x' + '11'.repeat(32);
    stubSubmitError = null;
    const payload = await buildPayload();
    const res = await app.inject({
      method: 'POST',
      url: '/wdk/relay/eip3009',
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: { txHash: string; reservationId: string; status: string; from: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.txHash).toBe(stubSubmitTxHash);
    expect(body.data.reservationId).toMatch(/^fac-/);
    expect(body.data.status).toBe('submitted');
    // Address in response is shortened.
    expect(body.data.from.includes('...')).toBe(true);
    // Row was persisted with the real txHash (not the pending placeholder).
    const row = facTxs.find((r) => r.txHash === stubSubmitTxHash);
    expect(row).toBeDefined();
    expect(row?.status).toBe('submitted');
  });

  test('reservation-first: concurrent duplicate submits only reach RPC once', async () => {
    // W4-HIGH-01 remediation: fire 5 identical payloads in parallel and verify
    // only ONE submitEip3009Relay invocation happens; the other 4 lose at DB
    // insert with P2002 and return 409 without touching the mocked RPC.
    stubSubmitTxHash = '0x' + '55'.repeat(32);
    stubSubmitError = null;
    stubSubmitCallCount = 0;
    const priorSubmitCount = facTxs.length;
    const payload = await buildPayload();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: 'POST', url: '/wdk/relay/eip3009', payload })
      )
    );
    const statusCodes = results.map((r) => r.statusCode).sort();
    expect(statusCodes.filter((c) => c === 200).length).toBe(1);
    expect(statusCodes.filter((c) => c === 409).length).toBe(4);
    // Exactly one row exists for this nonce.
    const nonce = (payload as unknown as { nonce: string }).nonce;
    const rowsForNonce = facTxs.filter((r) => r.nonce === nonce);
    expect(rowsForNonce.length).toBe(1);
    expect(rowsForNonce[0]?.status).toBe('submitted');
    // Verify only one submit reached the RPC stub — the 4 losers were rejected
    // at DB insert with P2002 and returned 409 before touching the RPC.
    expect(stubSubmitCallCount).toBe(1);
    // Total new rows added: 1
    expect(facTxs.length - priorSubmitCount).toBe(1);
  });

  test('submit RPC failure marks reservation as failed (never deleted)', async () => {
    // W4-HIGH-01 remediation: after reserving the DB row, if the on-chain
    // submit throws, the row must persist with status='failed' so nothing is
    // silently orphaned and ops can audit.
    const priorLen = facTxs.length;
    const payload = await buildPayload();
    stubSubmitTxHash = '0x' + '66'.repeat(32);
    stubSubmitError = new (facilitatorModule.FacilitatorRpcError as {
      new (cause: Error): Error;
    })(new Error('nonce broadcast rejected'));
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/wdk/relay/eip3009',
        payload,
      });
      expect(res.statusCode).toBe(502);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('RPC_SUBMIT_FAILED');
      // Reservation row exists with status='failed' and a pending: placeholder.
      const nonce = (payload as unknown as { nonce: string }).nonce;
      const row = facTxs.find((r) => r.nonce === nonce);
      expect(row).toBeDefined();
      expect(row?.status).toBe('failed');
      expect(row?.txHash.startsWith('pending:')).toBe(true);
      expect(row?.errorMessage).toBeTruthy();
      // Exactly one row was added.
      expect(facTxs.length - priorLen).toBe(1);
    } finally {
      stubSubmitError = null;
    }
  });

  test('409 on nonce replay (composite unique)', async () => {
    stubSubmitTxHash = '0x' + '22'.repeat(32);
    stubSubmitError = null;
    const payload = await buildPayload();
    // First submit — 200.
    const first = await app.inject({
      method: 'POST',
      url: '/wdk/relay/eip3009',
      payload,
    });
    expect(first.statusCode).toBe(200);
    // Same nonce — 409.
    stubSubmitTxHash = '0x' + '33'.repeat(32);
    const second = await app.inject({
      method: 'POST',
      url: '/wdk/relay/eip3009',
      payload,
    });
    expect(second.statusCode).toBe(409);
    const body = second.json() as { error: { code: string } };
    expect(body.error.code).toBe('NONCE_ALREADY_USED');
  });

  test('rate-limit header present on POST', async () => {
    const payload = await buildPayload();
    stubSubmitTxHash = '0x' + '44'.repeat(32);
    const res = await app.inject({
      method: 'POST',
      url: '/wdk/relay/eip3009',
      payload,
    });
    // Header exists regardless of status code.
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
  });
});

describe('GET /wdk/relay/status/:txHash', () => {
  test('returns the persisted row when found', async () => {
    // Any of the rows persisted above will do.
    const row = facTxs[0];
    if (!row) throw new Error('no prior row');
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/relay/status/${row.txHash}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { txHash: string; status: string; from: string } };
    expect(body.data.txHash).toBe(row.txHash);
    expect(body.data.status).toBe('submitted');
    expect(body.data.from.includes('...')).toBe(true);
  });

  test('404 for unknown tx hash', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/wdk/relay/status/0x' + 'de'.repeat(32),
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('TX_NOT_FOUND');
  });

  test('400 for malformed tx hash', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/wdk/relay/status/not-a-hash',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /wdk/relay/health', () => {
  test('returns 200 envelope with balances array when enabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/wdk/relay/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: {
        enabled: boolean;
        sponsorAddress: string | null;
        balances: unknown[];
        onlyRegisteredHosts: boolean;
        maxAmountUsdt: string;
      };
    };
    expect(body.data.enabled).toBe(true);
    expect(body.data.sponsorAddress).not.toBeNull();
    expect(Array.isArray(body.data.balances)).toBe(true);
    expect(body.data.onlyRegisteredHosts).toBe(true);
    expect(body.data.maxAmountUsdt).toBe('100');
  });
});
