/**
 * F10 route tests for /chains.
 *
 * Covers:
 *   - Response shape (defaultChainId + chains array).
 *   - Sepolia listed as enabled, Plasma listed as disabled.
 *   - RPC URLs are NEVER echoed (only the count).
 *   - Cache-Control header is set.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const { chainsRoutes, __resetChainsCacheForTest } = await import(
  '../../src/routes/chainsRoutes.ts'
);
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(chainsRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  __resetChainsCacheForTest();
});

interface ChainRow {
  chainId: number;
  name: string;
  enabled: boolean;
  healthy: boolean | null;
  lastBlockNumber: number | null;
  lagSeconds: number | null;
  usdtAddress: string;
  rpcCount: number;
}

interface ChainsResponse {
  success: true;
  error: null;
  data: { defaultChainId: number; chains: ChainRow[] };
}

describe('GET /chains', () => {
  test('returns the multi-chain registry with default = Sepolia', async () => {
    __resetChainsCacheForTest();
    const res = await app.inject({ method: 'GET', url: '/chains' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ChainsResponse;
    expect(body.success).toBe(true);
    expect(body.data.defaultChainId).toBe(11155111);
    const ids = body.data.chains.map((c) => c.chainId).sort((a, b) => a - b);
    expect(ids).toEqual([9746, 11155111]);
  });

  test('Sepolia row reports enabled=true; Plasma row enabled=false', async () => {
    __resetChainsCacheForTest();
    const res = await app.inject({ method: 'GET', url: '/chains' });
    const body = res.json() as ChainsResponse;
    const sep = body.data.chains.find((c) => c.chainId === 11155111);
    const pla = body.data.chains.find((c) => c.chainId === 9746);
    expect(sep?.enabled).toBe(true);
    expect(pla?.enabled).toBe(false);
    // Plasma has no USDT contract published yet — `usdtAddress` field should be empty.
    expect(pla?.usdtAddress).toBe('');
  });

  test('never echoes raw RPC URLs (only rpcCount)', async () => {
    __resetChainsCacheForTest();
    const res = await app.inject({ method: 'GET', url: '/chains' });
    const raw = res.payload;
    expect(raw).not.toContain('publicnode.com');
    expect(raw).not.toContain('rpc.sepolia.org');
    expect(raw).not.toContain('plasma.to');
    const body = res.json() as ChainsResponse;
    for (const c of body.data.chains) {
      expect(typeof c.rpcCount).toBe('number');
    }
  });

  test('sets a Cache-Control header so clients can co-operate', async () => {
    __resetChainsCacheForTest();
    const res = await app.inject({ method: 'GET', url: '/chains' });
    const cc = res.headers['cache-control'];
    expect(typeof cc).toBe('string');
    expect(String(cc)).toMatch(/max-age=\d+/);
  });

  test('disabled chains report healthy=null (Unknown), not false', async () => {
    __resetChainsCacheForTest();
    const res = await app.inject({ method: 'GET', url: '/chains' });
    const body = res.json() as ChainsResponse;
    const pla = body.data.chains.find((c) => c.chainId === 9746);
    expect(pla?.healthy).toBeNull();
    expect(pla?.lastBlockNumber).toBeNull();
    expect(pla?.lagSeconds).toBeNull();
  });
});
