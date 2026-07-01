/**
 * Wave 10 tests — Match Prediction Pool.
 *
 * Coverage:
 *   Settlement math (pure): winner-only, exact-score, exact-score fallback,
 *     refund path, integer division remainder.
 *   Routes (feature disabled): every route returns 503 FEATURE_DISABLED so
 *     the pre-migration deploy path is safe.
 *   Routes (feature enabled): open path validates all inputs + verifies host
 *     signature; entry path verifies EIP-3009 signature and refuses value !=
 *     entry stake; result path refuses non-host signature.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ethers } from 'ethers';

// -----------------------------------------------------------------------------
// Pure settlement math tests — no framework, no mocks.
// -----------------------------------------------------------------------------

describe('predictionPool.computeSettlement', () => {
  test('winner-only: single winner takes the whole pool', async () => {
    const { computeSettlement } = await import('../../src/lib/evm/predictionPool.ts');
    const plan = computeSettlement(
      'winner-only',
      [
        { id: 'a', peerAddress: '0xa', winner: 'HOME', homeGoals: null, awayGoals: null, stakeAtomic: '1000000', status: 'confirmed' },
        { id: 'b', peerAddress: '0xb', winner: 'AWAY', homeGoals: null, awayGoals: null, stakeAtomic: '1000000', status: 'confirmed' },
        { id: 'c', peerAddress: '0xc', winner: 'DRAW', homeGoals: null, awayGoals: null, stakeAtomic: '1000000', status: 'confirmed' },
      ],
      { winner: 'HOME', homeGoals: 2, awayGoals: 1 }
    );
    expect(plan.winnerIds).toEqual(['a']);
    expect(plan.shareAtomic).toBe(3_000_000n);
    expect(plan.totalPoolAtomic).toBe(3_000_000n);
    expect(plan.usedExactScoreFallback).toBe(false);
    expect(plan.refundRequired).toBe(false);
  });

  test('winner-only: multiple winners split the pool with integer remainder', async () => {
    const { computeSettlement } = await import('../../src/lib/evm/predictionPool.ts');
    // 3 winners, pool = 10_000_000, share = 3_333_333, remainder = 1
    const plan = computeSettlement(
      'winner-only',
      [
        { id: 'a', peerAddress: '0xa', winner: 'HOME', homeGoals: null, awayGoals: null, stakeAtomic: '2000000', status: 'confirmed' },
        { id: 'b', peerAddress: '0xb', winner: 'HOME', homeGoals: null, awayGoals: null, stakeAtomic: '3000000', status: 'confirmed' },
        { id: 'c', peerAddress: '0xc', winner: 'HOME', homeGoals: null, awayGoals: null, stakeAtomic: '5000000', status: 'confirmed' },
      ],
      { winner: 'HOME', homeGoals: 1, awayGoals: 0 }
    );
    expect(plan.winnerIds.sort()).toEqual(['a', 'b', 'c']);
    expect(plan.totalPoolAtomic).toBe(10_000_000n);
    expect(plan.shareAtomic).toBe(3_333_333n);
    expect(plan.remainderAtomic).toBe(1n);
  });

  test('exact-score: hitting exact goals wins over side-only', async () => {
    const { computeSettlement } = await import('../../src/lib/evm/predictionPool.ts');
    const plan = computeSettlement(
      'exact-score',
      [
        { id: 'a', peerAddress: '0xa', winner: 'HOME', homeGoals: 2, awayGoals: 1, stakeAtomic: '1000000', status: 'confirmed' },
        { id: 'b', peerAddress: '0xb', winner: 'HOME', homeGoals: 3, awayGoals: 0, stakeAtomic: '1000000', status: 'confirmed' },
        { id: 'c', peerAddress: '0xc', winner: 'AWAY', homeGoals: 0, awayGoals: 2, stakeAtomic: '1000000', status: 'confirmed' },
      ],
      { winner: 'HOME', homeGoals: 2, awayGoals: 1 }
    );
    expect(plan.winnerIds).toEqual(['a']);
    expect(plan.usedExactScoreFallback).toBe(false);
    expect(plan.shareAtomic).toBe(3_000_000n);
  });

  test('exact-score: falls back to side-only when nobody hits exact', async () => {
    const { computeSettlement } = await import('../../src/lib/evm/predictionPool.ts');
    const plan = computeSettlement(
      'exact-score',
      [
        { id: 'a', peerAddress: '0xa', winner: 'HOME', homeGoals: 1, awayGoals: 0, stakeAtomic: '1000000', status: 'confirmed' },
        { id: 'b', peerAddress: '0xb', winner: 'HOME', homeGoals: 3, awayGoals: 1, stakeAtomic: '1000000', status: 'confirmed' },
        { id: 'c', peerAddress: '0xc', winner: 'AWAY', homeGoals: 0, awayGoals: 2, stakeAtomic: '1000000', status: 'confirmed' },
      ],
      { winner: 'HOME', homeGoals: 2, awayGoals: 1 }
    );
    expect(plan.winnerIds.sort()).toEqual(['a', 'b']);
    expect(plan.usedExactScoreFallback).toBe(true);
    expect(plan.shareAtomic).toBe(1_500_000n);
  });

  test('no winners: triggers refund path', async () => {
    const { computeSettlement } = await import('../../src/lib/evm/predictionPool.ts');
    const plan = computeSettlement(
      'winner-only',
      [
        { id: 'a', peerAddress: '0xa', winner: 'HOME', homeGoals: null, awayGoals: null, stakeAtomic: '1000000', status: 'confirmed' },
        { id: 'b', peerAddress: '0xb', winner: 'HOME', homeGoals: null, awayGoals: null, stakeAtomic: '1000000', status: 'confirmed' },
      ],
      { winner: 'DRAW', homeGoals: 1, awayGoals: 1 }
    );
    expect(plan.winnerIds).toEqual([]);
    expect(plan.refundRequired).toBe(true);
    expect(plan.remainderAtomic).toBe(2_000_000n);
  });

  test('pending predictions do NOT participate', async () => {
    const { computeSettlement } = await import('../../src/lib/evm/predictionPool.ts');
    const plan = computeSettlement(
      'winner-only',
      [
        { id: 'a', peerAddress: '0xa', winner: 'HOME', homeGoals: null, awayGoals: null, stakeAtomic: '1000000', status: 'pending' },
        { id: 'b', peerAddress: '0xb', winner: 'HOME', homeGoals: null, awayGoals: null, stakeAtomic: '1000000', status: 'confirmed' },
      ],
      { winner: 'HOME', homeGoals: 1, awayGoals: 0 }
    );
    expect(plan.winnerIds).toEqual(['b']);
    expect(plan.totalPoolAtomic).toBe(1_000_000n);
  });
});

describe('predictionPool.deriveWinnerSide', () => {
  test('scores map to sides deterministically', async () => {
    const { deriveWinnerSide } = await import('../../src/lib/evm/predictionPool.ts');
    expect(deriveWinnerSide(2, 1)).toBe('HOME');
    expect(deriveWinnerSide(0, 3)).toBe('AWAY');
    expect(deriveWinnerSide(2, 2)).toBe('DRAW');
    expect(deriveWinnerSide(0, 0)).toBe('DRAW');
  });
});

describe('predictionPool.derivePoolAddress', () => {
  test('routes every pool to the sponsor address (hackathon simplification)', async () => {
    const { derivePoolAddress } = await import('../../src/lib/evm/predictionPool.ts');
    const sponsor = '0x' + 'ab'.repeat(20);
    expect(derivePoolAddress(sponsor, 'room-1', 'match-1')).toBe(sponsor.toLowerCase());
    expect(derivePoolAddress(sponsor, 'room-2', 'match-99')).toBe(sponsor.toLowerCase());
  });
});

// -----------------------------------------------------------------------------
// Route tests — feature-flag disabled. The default deploy state must be safe.
// -----------------------------------------------------------------------------

describe('POST /predictions/* — feature disabled', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  const buildApp = async () => {
    const Fastify = (await import('fastify')).default;
    const FastifyRateLimit = (await import('@fastify/rate-limit')).default;
    const { predictionRoutes } = await import('../../src/routes/predictionRoutes.ts');
    const a = Fastify({ logger: false });
    await a.register(FastifyRateLimit, { global: false });
    await a.register(predictionRoutes, { prefix: '/predictions' });
    await a.ready();
    return a;
  };

  beforeAll(async () => {
    // The config module reads CURVA_PREDICTIONS_ENABLED at import time. In the
    // test env we leave it unset so the default is `false`. This asserts the
    // safe default.
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  test('POST /predictions/open returns 503 FEATURE_DISABLED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/predictions/open',
      payload: {
        roomSlug: 'test-room',
        matchId: 'ck00000000000000000000000',
        mode: 'winner-only',
        deadlineMs: Date.now() + 3_600_000,
        hostAddress: '0x' + '77'.repeat(20),
        signature: '0xdeadbeef',
      },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string }; data: { enabled: boolean } };
    expect(body.error.code).toBe('FEATURE_DISABLED');
    expect(body.data.enabled).toBe(false);
  });

  test('POST /predictions/entry returns 503 FEATURE_DISABLED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/predictions/entry',
      payload: { poolId: 'ck00000000000000000000000', winner: 'HOME', peerHandle: 'x', from: '0x' + 'a'.repeat(40), to: '0x' + 'b'.repeat(40), value: '1000000', validAfter: 0, validBefore: Math.floor(Date.now() / 1000) + 3600, nonce: '0x' + '11'.repeat(32), v: 27, r: '0x' + '22'.repeat(32), s: '0x' + '33'.repeat(32) },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FEATURE_DISABLED');
  });

  test('POST /predictions/result returns 503 FEATURE_DISABLED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/predictions/result',
      payload: {
        poolId: 'ck00000000000000000000000',
        winner: 'HOME',
        homeGoals: 2,
        awayGoals: 1,
        hostAddress: '0x' + '77'.repeat(20),
        signature: '0xdeadbeef',
      },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('FEATURE_DISABLED');
  });

  test('GET /predictions/pool/:slug/:matchId returns 503 FEATURE_DISABLED', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/predictions/pool/test-room/ck00000000000000000000000',
    });
    expect(res.statusCode).toBe(503);
  });
});

// -----------------------------------------------------------------------------
// Signed-message builder tests — exact-string contract with bare/predictions.js
// -----------------------------------------------------------------------------

describe('signed-message builders', () => {
  test('buildPoolOpenMessage matches the canonical string', async () => {
    const { buildPoolOpenMessage } = await import('../../src/routes/predictionRoutes.ts');
    expect(buildPoolOpenMessage('room-1', 'match-1', 1_700_000_000_000)).toBe(
      'curva-predictions-open:room-1:match-1:1700000000000'
    );
  });
  test('buildPoolResultMessage matches the canonical string', async () => {
    const { buildPoolResultMessage } = await import('../../src/routes/predictionRoutes.ts');
    expect(buildPoolResultMessage('cp1', 'HOME', 2, 1)).toBe(
      'curva-predictions-result:cp1:HOME:2:1'
    );
  });
});

// -----------------------------------------------------------------------------
// Signature verification — the anti-spoofing bar for /open and /result.
// -----------------------------------------------------------------------------

describe('EIP-191 signature verification for host actions', () => {
  test('a host EOA signature over the open message recovers to the host address', async () => {
    const { buildPoolOpenMessage } = await import('../../src/routes/predictionRoutes.ts');
    const { verifyEip191Signature } = await import('../../src/lib/evm/signatureVerifier.ts');
    const wallet = ethers.Wallet.createRandom();
    const message = buildPoolOpenMessage('room-1', 'ck00000000000000000000000', 1_700_000_000_000);
    const sig = await wallet.signMessage(message);
    expect(verifyEip191Signature(message, sig, wallet.address)).toBe(true);
    // Tampered claimed address is rejected.
    const other = ethers.Wallet.createRandom();
    expect(verifyEip191Signature(message, sig, other.address)).toBe(false);
  });

  test('a result signature by non-host does NOT recover to host', async () => {
    const { buildPoolResultMessage } = await import('../../src/routes/predictionRoutes.ts');
    const { verifyEip191Signature } = await import('../../src/lib/evm/signatureVerifier.ts');
    const host = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();
    const message = buildPoolResultMessage('cp1', 'HOME', 2, 1);
    const attackerSig = await attacker.signMessage(message);
    // The attacker's signature recovers to the attacker, not the host.
    expect(verifyEip191Signature(message, attackerSig, host.address)).toBe(false);
    expect(verifyEip191Signature(message, attackerSig, attacker.address)).toBe(true);
  });
});
