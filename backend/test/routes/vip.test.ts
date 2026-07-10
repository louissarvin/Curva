/**
 * Semifinal Wave - integration tests for POST /vip/reserve + GET /vip/status/:slug.
 *
 * Docs-verification memo
 * ----------------------
 * Test posture verified against:
 *   - https://x402.org spec, retrieved 2026-07-10 (challenge body shape)
 *   - https://docs.wdk.tether.io/ai/x402/ (WDK EIP-3009 exact scheme)
 *   - https://eips.ethereum.org/EIPS/eip-3009 (TransferWithAuthorization struct)
 *
 * Coverage:
 *   - Feature flag off                                -> 503 FEATURE_DISABLED
 *   - No X-Payment header + valid slug                -> 402 with canonical
 *                                                        challenge scoped to slug
 *   - Bad slug shape                                  -> 400 BAD_SLUG
 *   - Slug already reserved (fast-fail)               -> 409 SLUG_ALREADY_RESERVED
 *   - Valid X-Payment + valid signature               -> 200 with reservation
 *   - Reused nonce (facilitator throws NONCE_USED)    -> 409 NONCE_USED
 *   - Malformed X-Payment                             -> 400 BAD_PAYMENT_HEADER
 *   - GET /vip/status/:slug reflects insert state
 *
 * The Prisma layer is stubbed via mock.module so the tests never touch a real
 * database. Same convention used across the backend test suite.
 */

process.env.ENABLE_VIP_RESERVATIONS = 'true';
process.env.CURVA_X402_ENABLED = 'true';
process.env.VIP_RATE_LIMIT_MAX = '10000';
process.env.VIP_STATUS_RATE_LIMIT_MAX = '10000';

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// Force-flip config flags on regardless of import order.
// ---------------------------------------------------------------------------
const mainConfigModule = await import('../../src/config/main-config.ts');
mock.module('../../src/config/main-config.ts', () => ({
  ...mainConfigModule,
  ENABLE_VIP_RESERVATIONS: true,
  CURVA_X402_ENABLED: true,
  VIP_RATE_LIMIT_MAX: 10000,
  VIP_STATUS_RATE_LIMIT_MAX: 10000,
}));

// ---------------------------------------------------------------------------
// Stub the EIP-712 domain lookup so no RPC roundtrip happens.
// ---------------------------------------------------------------------------
// Token address MUST match the runtime RELAY_ALLOWED_TOKENS captured at
// main-config import time (backend/.env sets this to the local dev USDT
// deployment). If we hard-code a different token the verifyX402Payment path
// throws TOKEN_NOT_ALLOWED and the payment-path tests can never reach the
// facilitator stub. Reading from process.env keeps the test resilient to
// .env drift across machines.
const TOKEN = ((process.env.RELAY_ALLOWED_TOKENS || '').split(',')[0] || '')
  .trim()
  .toLowerCase() || '0xd077a400968890eacc75cdc901f0356c943e4fdb';
const DOMAIN = {
  name: 'USDT',
  version: '1',
  chainId: 11155111,
  verifyingContract: TOKEN,
};

const eip3009Module = await import('../../src/lib/evm/eip3009.ts');
const { EIP3009_TYPES } = eip3009Module;
const originalRecover = eip3009Module.recoverEip3009Signer;

mock.module('../../src/lib/evm/eip3009.ts', () => ({
  ...eip3009Module,
  fetchEip3009Domain: async () => DOMAIN,
  recoverEip3009Signer: originalRecover,
  EIP3009_TYPES,
}));

// ---------------------------------------------------------------------------
// Facilitator: swap sponsor + intercept submitEip3009Relay.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Stub the VIP store so tests don't need Postgres. Behaves like a Map keyed
// by slug + txHash.
// ---------------------------------------------------------------------------
const storeState = new Map<string, {
  id: string;
  slug: string;
  ownerAddress: string;
  txHash: string;
  reservedAt: Date;
}>();
const txHashIndex = new Map<string, string>(); // txHash -> slug

const storeModule = await import('../../src/lib/vip/store.ts');
const { SlugTakenError, TxHashTakenError, normalizeVipSlug, isValidVipSlug, VIP_SLUG_RE } =
  storeModule;

mock.module('../../src/lib/vip/store.ts', () => ({
  SlugTakenError,
  TxHashTakenError,
  normalizeVipSlug,
  isValidVipSlug,
  VIP_SLUG_RE,
  getReservation: async (slug: string) => storeState.get(slug) ?? null,
  createReservation: async (opts: { slug: string; ownerAddress: string; txHash: string }) => {
    const slug = normalizeVipSlug(opts.slug);
    if (storeState.has(slug)) throw new SlugTakenError(slug);
    if (txHashIndex.has(opts.txHash.toLowerCase())) {
      throw new TxHashTakenError(opts.txHash.toLowerCase());
    }
    const row = {
      id: 'id-' + slug,
      slug,
      ownerAddress: opts.ownerAddress.toLowerCase(),
      txHash: opts.txHash.toLowerCase(),
      reservedAt: new Date(),
    };
    storeState.set(slug, row);
    txHashIndex.set(row.txHash, slug);
    return row;
  },
  listReservationsByOwner: async () => [],
}));

// ---------------------------------------------------------------------------
// Import route AFTER mocks are wired.
// ---------------------------------------------------------------------------
const { vipRoutes } = await import('../../src/routes/vipRoutes.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;
let signerWallet: ethers.HDNodeWallet;
let sponsorWallet: ethers.Wallet;

const signAuth = async (
  wallet: ethers.HDNodeWallet,
  msg: {
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
    msg
  );
  return ethers.Signature.from(raw);
};

const buildValidPayment = async (): Promise<string> => {
  const from = signerWallet.address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const message = {
    from,
    to: sponsorWallet.address.toLowerCase(),
    value: '5000000',
    validAfter: 0,
    validBefore: now + 900,
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const sig = await signAuth(signerWallet, message);
  return JSON.stringify({
    network: 'eip155:11155111',
    tokenAddress: TOKEN,
    ...message,
    v: sig.v,
    r: sig.r,
    s: sig.s,
  });
};

beforeAll(async () => {
  signerWallet = ethers.Wallet.createRandom();
  sponsorWallet = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)));
  __setSponsorForTest(sponsorWallet);
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(vipRoutes, { prefix: '/vip' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  __setSponsorForTest(null);
  __resetBalanceCacheForTest();
});

afterEach(() => {
  storeState.clear();
  txHashIndex.clear();
  stubSubmitError = null;
  stubSubmitCallCount = 0;
});

// ===========================================================================
describe('POST /vip/reserve - challenge issuance', () => {
  test('402 with slug-scoped challenge when no X-Payment header sent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/vip/reserve',
      payload: { slug: 'kings-lounge' },
    });
    expect(res.statusCode).toBe(402);
    const body = res.json() as {
      x402Version: number;
      accepts: Array<{
        scheme: string;
        network: string;
        maxAmountRequired: string;
        asset: string;
        payTo: string;
        resource: string;
        nonce: string;
        validBefore: number;
        extra?: { slug?: string; vipSlug?: string };
      }>;
    };
    expect(body.x402Version).toBe(1);
    expect(body.accepts.length).toBe(1);
    const a = body.accepts[0]!;
    expect(a.scheme).toBe('exact');
    expect(a.network).toBe('eip155:11155111');
    expect(a.maxAmountRequired).toBe('5000000');
    // Challenge asset is CURVA_X402_TOKEN_ADDRESS (main-config), NOT the
    // payment header's tokenAddress. Just assert well-formed hex.
    expect(a.asset).toMatch(/^0x[0-9a-f]{40}$/);
    expect(a.payTo).toBe(sponsorWallet.address.toLowerCase());
    expect(a.resource).toBe('vip-reservation');
    expect(a.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.extra?.slug).toBe('kings-lounge');
    expect(a.extra?.vipSlug).toBe('vip-kings-lounge');
    expect(res.headers['x-payment-required']).toBeDefined();
  });

  test('400 BAD_SLUG when slug fails the regex', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/vip/reserve',
      payload: { slug: 'bad slug with space' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('BAD_SLUG');
  });

  test('400 BAD_SLUG when slug too short', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/vip/reserve',
      payload: { slug: 'ab' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('BAD_SLUG');
  });

  test('400 BAD_SLUG when slug missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/vip/reserve',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('BAD_SLUG');
  });

  test('client may include vip- prefix; server strips it before validation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/vip/reserve',
      payload: { slug: 'vip-normalised-form' },
    });
    expect(res.statusCode).toBe(402);
    const body = res.json() as {
      accepts: Array<{ extra?: { slug?: string } }>;
    };
    expect(body.accepts[0]?.extra?.slug).toBe('normalised-form');
  });
});

// ===========================================================================
describe('POST /vip/reserve - payment path', () => {
  test('200 with reservation when payment is valid + slug is available', async () => {
    stubSubmitTxHash = '0x' + '11'.repeat(32);
    const payment = await buildValidPayment();
    const res = await app.inject({
      method: 'POST',
      url: '/vip/reserve',
      payload: { slug: 'legends-box' },
      headers: { 'x-payment': payment },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: {
        reservation: {
          slug: string;
          vipSlug: string;
          ownerAddress: string;
          txHash: string;
          reservedAt: string;
        };
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.reservation.slug).toBe('legends-box');
    expect(body.data.reservation.vipSlug).toBe('vip-legends-box');
    expect(body.data.reservation.ownerAddress).toBe(signerWallet.address.toLowerCase());
    expect(body.data.reservation.txHash).toBe(stubSubmitTxHash);
    expect(stubSubmitCallCount).toBe(1);
    expect(res.headers['x-payment-response']).toBeDefined();
  });

  test('400 BAD_PAYMENT_HEADER when header is malformed JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/vip/reserve',
      payload: { slug: 'legends-box' },
      headers: { 'x-payment': '{not json' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('BAD_PAYMENT_HEADER');
  });

  test('409 NONCE_USED when facilitator reports the nonce is spent', async () => {
    stubSubmitError = new (facilitatorModule.FacilitatorNonceUsedError as {
      new (): Error;
    })();
    const payment = await buildValidPayment();
    const res = await app.inject({
      method: 'POST',
      url: '/vip/reserve',
      payload: { slug: 'nonce-taken' },
      headers: { 'x-payment': payment },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NONCE_USED');
  });

  test('409 SLUG_ALREADY_RESERVED before payment when slug is taken', async () => {
    // Prime store with a prior reservation.
    storeState.set('taken-slug', {
      id: 'existing',
      slug: 'taken-slug',
      ownerAddress: '0x' + 'cc'.repeat(20),
      txHash: '0x' + 'dd'.repeat(32),
      reservedAt: new Date('2026-07-09T12:00:00.000Z'),
    });
    // Even without an X-Payment header, taken slugs return 409 immediately.
    const res = await app.inject({
      method: 'POST',
      url: '/vip/reserve',
      payload: { slug: 'taken-slug' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as {
      error: { code: string };
      data: { reservation: { ownerAddress: string; reservedAt: string } };
    };
    expect(body.error.code).toBe('SLUG_ALREADY_RESERVED');
    expect(body.data.reservation.ownerAddress).toBe('0x' + 'cc'.repeat(20));
    expect(body.data.reservation.reservedAt).toBe('2026-07-09T12:00:00.000Z');
    // And no settlement path fired.
    expect(stubSubmitCallCount).toBe(0);
  });
});

// ===========================================================================
describe('GET /vip/status/:slug', () => {
  test('200 with reserved:false for an unreserved slug', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/vip/status/wide-open',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { reserved: boolean; vipSlug: string } };
    expect(body.data.reserved).toBe(false);
    expect(body.data.vipSlug).toBe('vip-wide-open');
  });

  test('200 with reservation details for a reserved slug', async () => {
    storeState.set('reserved-one', {
      id: 'r1',
      slug: 'reserved-one',
      ownerAddress: '0x' + 'ab'.repeat(20),
      txHash: '0x' + '11'.repeat(32),
      reservedAt: new Date('2026-07-10T08:15:00.000Z'),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/vip/status/reserved-one',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: {
        reserved: boolean;
        slug: string;
        vipSlug: string;
        ownerAddress: string;
        reservedAt: string;
        txHash: string;
      };
    };
    expect(body.data.reserved).toBe(true);
    expect(body.data.slug).toBe('reserved-one');
    expect(body.data.vipSlug).toBe('vip-reserved-one');
    expect(body.data.ownerAddress).toBe('0x' + 'ab'.repeat(20));
    expect(body.data.txHash).toBe('0x' + '11'.repeat(32));
    expect(body.data.reservedAt).toBe('2026-07-10T08:15:00.000Z');
  });

  test('400 BAD_SLUG on invalid slug', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/vip/status/ab', // too short
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('BAD_SLUG');
  });

  test('slug prefix normalization: request with vip- prefix resolves to same row', async () => {
    storeState.set('prefixed', {
      id: 'r2',
      slug: 'prefixed',
      ownerAddress: '0x' + 'ef'.repeat(20),
      txHash: '0x' + '22'.repeat(32),
      reservedAt: new Date('2026-07-10T09:00:00.000Z'),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/vip/status/vip-prefixed',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { reserved: boolean; slug: string } };
    expect(body.data.reserved).toBe(true);
    expect(body.data.slug).toBe('prefixed');
  });
});

// ===========================================================================
describe('POST /vip/reserve - feature flag off', () => {
  test('503 FEATURE_DISABLED when the facilitator is toggled off', async () => {
    __setSponsorForTest(null);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/vip/reserve',
        payload: { slug: 'closed-shop' },
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe('FEATURE_DISABLED');
    } finally {
      __setSponsorForTest(sponsorWallet);
    }
  });
});
