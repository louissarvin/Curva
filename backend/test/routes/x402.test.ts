/**
 * Wave 13B - integration tests for /x402/premium-translations.
 *
 * Coverage:
 *   - Feature flag off  -> 503 FEATURE_DISABLED
 *   - Feature flag on, no X-Payment header -> 402 with canonical challenge shape
 *   - Valid X-Payment header + valid signature -> 200 with resource payload
 *   - Malformed X-Payment header -> 400 BAD_PAYMENT_HEADER
 *   - Reused nonce (mocked facilitator throws NONCE_USED) -> 409 NONCE_USED
 *   - Invalid signature (wrong signer) -> 400 INVALID_SIGNATURE
 *   - Unlock cache: second call from same peer skips settle path
 */

// Env must be set BEFORE main-config is imported. Bun test loads setup.ts
// first (per bunfig.toml), then this file. Setting via process.env here still
// works ONLY if this test runs in isolation. When the full suite runs, other
// test files that already imported main-config.ts have cached the (false)
// flag, so we override the specific exports via mock.module below.
process.env.CURVA_X402_ENABLED = 'true';
process.env.CURVA_X402_RATE_LIMIT_MAX = '10000';

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { ethers } from 'ethers';

// Force-flip the flag on regardless of import order. Everything else stays as
// main-config already computed it.
const mainConfigModule = await import('../../src/config/main-config.ts');
mock.module('../../src/config/main-config.ts', () => ({
  ...mainConfigModule,
  CURVA_X402_ENABLED: true,
  CURVA_X402_RATE_LIMIT_MAX: 10000,
}));

// ---------------------------------------------------------------------------
// Stub the EIP-712 domain lookup so no RPC roundtrip happens. Same convention
// as facilitator.test.ts.
// ---------------------------------------------------------------------------

const TOKEN = '0xd077a400968890eacc75cdc901f0356c943e4fdb';
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
// Stub facilitator: swap the sponsor + intercept submitEip3009Relay so tests
// never hit the real RPC.
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

// Reset the in-memory unlock cache between tests to keep replay behavior clean.
const x402Module = await import('../../src/lib/evm/x402.ts');
const { __resetUnlocksForTest } = x402Module;

// ---------------------------------------------------------------------------
// Import route AFTER the mocks are wired up.
// ---------------------------------------------------------------------------

const { x402Routes } = await import('../../src/routes/x402Routes.ts');
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
    value: '1000000',
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
  await app.register(x402Routes, { prefix: '/x402' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  __setSponsorForTest(null);
  __resetBalanceCacheForTest();
  __resetUnlocksForTest();
});

describe('GET /x402/premium-translations - challenge issuance', () => {
  test('402 with canonical x402 body when no X-Payment header sent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/x402/premium-translations',
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
      }>;
    };
    expect(body.x402Version).toBe(1);
    expect(body.accepts.length).toBe(1);
    const a = body.accepts[0]!;
    expect(a.scheme).toBe('exact');
    expect(a.network).toBe('eip155:11155111');
    expect(a.maxAmountRequired).toBe('1000000');
    expect(a.asset).toBe(TOKEN);
    expect(a.payTo).toBe(sponsorWallet.address.toLowerCase());
    expect(a.resource).toBe('premium-translations');
    expect(a.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    // Mirrored header for header-only clients.
    expect(res.headers['x-payment-required']).toBeDefined();
  });
});

describe('GET /x402/premium-translations - payment path', () => {
  test('200 with resource payload when payment is valid', async () => {
    stubSubmitError = null;
    stubSubmitTxHash = '0x' + '11'.repeat(32);
    stubSubmitCallCount = 0;
    const payment = await buildValidPayment();
    const res = await app.inject({
      method: 'GET',
      url: '/x402/premium-translations',
      headers: { 'x-payment': payment },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: boolean; data: { resource: string; models: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.resource).toBe('premium-translations');
    expect(body.data.models.length).toBe(2);
    expect(stubSubmitCallCount).toBe(1);
    expect(res.headers['x-payment-response']).toBeDefined();
  });

  test('400 BAD_PAYMENT_HEADER when header is malformed JSON', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/x402/premium-translations',
      headers: { 'x-payment': '{not json' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('BAD_PAYMENT_HEADER');
  });

  test('400 INVALID_SIGNATURE when a different wallet signed the message', async () => {
    __resetUnlocksForTest();
    stubSubmitError = null;
    const other = ethers.Wallet.createRandom();
    const now = Math.floor(Date.now() / 1000);
    const msg = {
      from: signerWallet.address.toLowerCase(),
      to: sponsorWallet.address.toLowerCase(),
      value: '1000000',
      validAfter: 0,
      validBefore: now + 900,
      nonce: ethers.hexlify(ethers.randomBytes(32)),
    };
    const badSig = await signAuth(other as unknown as ethers.HDNodeWallet, msg);
    const payment = JSON.stringify({
      network: 'eip155:11155111',
      tokenAddress: TOKEN,
      ...msg,
      v: badSig.v,
      r: badSig.r,
      s: badSig.s,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/x402/premium-translations',
      headers: { 'x-payment': payment },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_SIGNATURE');
  });

  test('409 NONCE_USED when facilitator reports the nonce is spent', async () => {
    __resetUnlocksForTest();
    // Fresh signer so the unlock cache does not short-circuit.
    signerWallet = ethers.Wallet.createRandom();
    stubSubmitError = new (facilitatorModule.FacilitatorNonceUsedError as {
      new (): Error;
    })();
    try {
      const payment = await buildValidPayment();
      const res = await app.inject({
        method: 'GET',
        url: '/x402/premium-translations',
        headers: { 'x-payment': payment },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('NONCE_USED');
    } finally {
      stubSubmitError = null;
    }
  });

  test('unlock cache: second call for same peer skips submit', async () => {
    __resetUnlocksForTest();
    signerWallet = ethers.Wallet.createRandom();
    stubSubmitError = null;
    stubSubmitCallCount = 0;
    const first = await app.inject({
      method: 'GET',
      url: '/x402/premium-translations',
      headers: { 'x-payment': await buildValidPayment() },
    });
    expect(first.statusCode).toBe(200);
    expect(stubSubmitCallCount).toBe(1);
    // Second call: fresh payment header but same signer -> cache hit.
    const second = await app.inject({
      method: 'GET',
      url: '/x402/premium-translations',
      headers: { 'x-payment': await buildValidPayment() },
    });
    expect(second.statusCode).toBe(200);
    // No new submit call.
    expect(stubSubmitCallCount).toBe(1);
    const respHeader = second.headers['x-payment-response'];
    expect(respHeader).toBeDefined();
    const parsedResp = JSON.parse(String(respHeader));
    expect(parsedResp.replay).toBe(true);
  });
});

describe('GET /x402/premium-translations - feature flag off', () => {
  test('503 FEATURE_DISABLED when the facilitator is toggled off', async () => {
    __setSponsorForTest(null);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/x402/premium-translations',
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('FEATURE_DISABLED');
    } finally {
      // Restore for the rest of the suite (test ordering safety).
      __setSponsorForTest(sponsorWallet);
    }
  });
});
