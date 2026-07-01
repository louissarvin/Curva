/**
 * Route tests for GET /pricing/usdt (Wave 7 Zone C).
 *
 * Uses the injectable fetch seam from the pricing library so we never hit the
 * real Bitfinex or Frankfurter services.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

const { pricingRoutes } = await import('../../src/routes/pricingRoutes.ts');
const {
  __resetCacheForTest,
  __setFetchForTest,
} = await import('../../src/lib/pricing/bitfinex.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;
let calls: string[] = [];
let handler: (url: string) => { ok: boolean; status: number; body: string } = () => ({
  ok: true,
  status: 200,
  body: '[]',
});

const bitfinexOk = (last: number): string =>
  JSON.stringify([
    ['tUSTUSD', 0.9999, 100, 1.0001, 100, 0.0001, 0.0001, last, 1_000_000, 1.001, 0.998],
  ]);

const frankfurterOk = (): string =>
  JSON.stringify({
    amount: 1.0,
    base: 'USD',
    date: '2026-07-01',
    rates: { BRL: 5.1874, EUR: 0.8785, GBP: 0.75528, IDR: 17961, JPY: 162.71, MXN: 17.5341 },
  });

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(pricingRoutes, { prefix: '/pricing' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  __setFetchForTest(null);
});

beforeEach(() => {
  __resetCacheForTest();
  calls = [];
  __setFetchForTest(async (url: string) => {
    calls.push(url);
    const r = handler(url);
    return { ok: r.ok, status: r.status, text: async () => r.body };
  });
});

afterEach(() => {
  // handler resets in each test.
});

describe('GET /pricing/usdt', () => {
  test('200 for USD (Bitfinex peg only)', async () => {
    handler = (url) => {
      if (url.includes('bitfinex')) return { ok: true, status: 200, body: bitfinexOk(1.0001) };
      return { ok: false, status: 500, body: '' };
    };
    const res = await app.inject({ method: 'GET', url: '/pricing/usdt?currency=USD' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { rate: number; currency: string; stale: boolean } };
    expect(body.data.currency).toBe('USD');
    expect(body.data.rate).toBe(1.0001);
    expect(body.data.stale).toBe(false);
    expect(res.headers['cache-control']).toContain('max-age=60');
  });

  test('200 for IDR (Bitfinex + Frankfurter)', async () => {
    handler = (url) => {
      if (url.includes('bitfinex')) return { ok: true, status: 200, body: bitfinexOk(1) };
      if (url.includes('frankfurter')) return { ok: true, status: 200, body: frankfurterOk() };
      return { ok: false, status: 500, body: '' };
    };
    const res = await app.inject({ method: 'GET', url: '/pricing/usdt?currency=IDR' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { rate: number; currency: string } };
    expect(body.data.currency).toBe('IDR');
    expect(body.data.rate).toBe(17961);
  });

  test('lowercase currency is normalised', async () => {
    handler = (url) => {
      if (url.includes('bitfinex')) return { ok: true, status: 200, body: bitfinexOk(1) };
      if (url.includes('frankfurter')) return { ok: true, status: 200, body: frankfurterOk() };
      return { ok: false, status: 500, body: '' };
    };
    const res = await app.inject({ method: 'GET', url: '/pricing/usdt?currency=eur' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { currency: string } };
    expect(body.data.currency).toBe('EUR');
  });

  test('400 for unknown currency', async () => {
    const res = await app.inject({ method: 'GET', url: '/pricing/usdt?currency=XYZ' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_CURRENCY');
  });

  test('400 for missing currency', async () => {
    const res = await app.inject({ method: 'GET', url: '/pricing/usdt' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_CURRENCY');
  });

  test('503-ish path: upstream down + empty cache returns 500 with Retry-After', async () => {
    handler = () => ({ ok: false, status: 500, body: '' });
    const res = await app.inject({ method: 'GET', url: '/pricing/usdt?currency=BRL' });
    // handleServerError returns 500 in this codebase; important is the
    // Retry-After hint so clients back off.
    expect(res.statusCode).toBe(500);
    expect(res.headers['retry-after']).toBe('30');
  });

  test('response never leaks stack traces on failure', async () => {
    handler = () => ({ ok: false, status: 502, body: 'internal upstream boom' });
    const res = await app.inject({ method: 'GET', url: '/pricing/usdt?currency=GBP' });
    const body = res.json() as { error: { message: string; stack?: string } };
    expect(body.error.message).not.toContain('boom');
  });

  test('response envelope matches project standard', async () => {
    handler = (url) => {
      if (url.includes('bitfinex')) return { ok: true, status: 200, body: bitfinexOk(1) };
      if (url.includes('frankfurter')) return { ok: true, status: 200, body: frankfurterOk() };
      return { ok: false, status: 500, body: '' };
    };
    const res = await app.inject({ method: 'GET', url: '/pricing/usdt?currency=MXN' });
    const body = res.json() as {
      success: boolean;
      error: unknown;
      data: {
        rate: number;
        source: string;
        currency: string;
        fetchedAt: string;
        stale: boolean;
      };
    };
    expect(body.success).toBe(true);
    expect(body.error).toBeNull();
    expect(typeof body.data.rate).toBe('number');
    expect(typeof body.data.source).toBe('string');
    expect(typeof body.data.fetchedAt).toBe('string');
    expect(body.data.stale).toBe(false);
  });
});
