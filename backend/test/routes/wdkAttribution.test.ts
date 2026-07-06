/**
 * Route tests for GET /wdk/verify-attribution/:userOpHash (F15 Wave 11).
 *
 * Covers:
 *   - generateExpectedMarker deterministic hex for the Curva marker params
 *   - 200 verified:true when the observed callData suffix matches
 *   - 200 verified:false when the suffix mismatches
 *   - 200 verified:false, note:'bundler_unreachable' when bundler is down
 *   - 200 verified:false, note:'userop_not_found_or_marker_absent' when the
 *     bundler returns an empty result
 *   - 404 VALIDATION_ERROR when the userOpHash is malformed
 *   - rate limit headers wired on the route
 *
 * Uses bun:test's `mock.module` for prisma (so error logging can be a no-op)
 * and swaps `globalThis.fetch` for the bundler round-trip. No network I/O.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';

const fakePrisma = {
  errorLog: { create: async () => ({}) },
};

mock.module('../../src/lib/prisma.ts', () => ({ prismaQuery: fakePrisma }));

const { wdkAttributionRoutes, generateExpectedMarker, CURVA_MARKER_PARAMS } =
  await import('../../src/routes/wdkAttributionRoutes.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;

const VALID_HASH = '0x' + 'ab'.repeat(32);

// Save the real fetch so each test can plug its own stub in cleanly.
const REAL_FETCH = globalThis.fetch;

const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<Response> | Response): void => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return impl(url, init);
  }) as typeof globalThis.fetch;
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(wdkAttributionRoutes, { prefix: '/wdk' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  globalThis.fetch = REAL_FETCH;
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe('generateExpectedMarker', () => {
  test('produces a 64-char lowercase hex string with the 5afe00 prefix', () => {
    const marker = generateExpectedMarker(CURVA_MARKER_PARAMS);
    expect(marker).toMatch(/^[0-9a-f]{64}$/);
    expect(marker.startsWith('5afe00')).toBe(true);
  });

  test('is deterministic for the Curva marker params', () => {
    const a = generateExpectedMarker(CURVA_MARKER_PARAMS);
    const b = generateExpectedMarker({
      project: 'curva',
      platform: 'Widget',
      tool: 'curva-wallet',
      toolVersion: '0.1.0',
    });
    expect(a).toBe(b);
  });

  test('changes when any field changes (avalanche via keccak)', () => {
    const base = generateExpectedMarker(CURVA_MARKER_PARAMS);
    const flipped = generateExpectedMarker({
      ...CURVA_MARKER_PARAMS,
      toolVersion: '0.1.1',
    });
    expect(flipped).not.toBe(base);
    // Only the tail 6 chars should differ (toolVersion is the last field).
    expect(flipped.slice(0, -6)).toBe(base.slice(0, -6));
    expect(flipped.slice(-6)).not.toBe(base.slice(-6));
  });
});

describe('GET /wdk/verify-attribution/:userOpHash', () => {
  test('404 VALIDATION_ERROR when userOpHash is malformed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/wdk/verify-attribution/not-a-hash',
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  test('verified:true when bundler callData suffix matches the expected marker', async () => {
    const expected = generateExpectedMarker(CURVA_MARKER_PARAMS);
    // Fabricate a callData where the last 64 hex chars are the expected marker.
    const callData = '0x' + '11'.repeat(80) + expected;
    stubFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: { callData } })
    );
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/verify-attribution/${VALID_HASH}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: {
        verified: boolean;
        observedMarker: string;
        expectedMarker: string;
        expected: { project: string; platform: string; tool: string; toolVersion: string };
        note?: string;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.verified).toBe(true);
    expect(body.data.observedMarker).toBe(expected);
    expect(body.data.expectedMarker).toBe(expected);
    expect(body.data.expected.project).toBe('curva');
    expect(body.data.expected.platform).toBe('Widget');
    expect(body.data.note).toBeUndefined();
  });

  test('verified:false when callData suffix does not match the expected marker', async () => {
    const callData = '0x' + '22'.repeat(200); // no marker
    stubFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: { callData } })
    );
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/verify-attribution/${VALID_HASH}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { verified: boolean; observedMarker: string; expectedMarker: string };
    };
    expect(body.data.verified).toBe(false);
    expect(body.data.observedMarker).toBe(callData.slice(-64).toLowerCase());
    expect(body.data.expectedMarker).toMatch(/^5afe00/);
    expect(body.data.observedMarker).not.toBe(body.data.expectedMarker);
  });

  test('verified:false, note:bundler_unreachable when bundler transport fails', async () => {
    stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/verify-attribution/${VALID_HASH}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: boolean;
      data: { verified: boolean; note?: string; observedMarker: null };
    };
    expect(body.success).toBe(true);
    expect(body.data.verified).toBe(false);
    expect(body.data.note).toBe('bundler_unreachable');
    expect(body.data.observedMarker).toBeNull();
  });

  test('verified:false, note:bundler_unreachable on non-2xx HTTP from bundler', async () => {
    stubFetch(async () => new Response('bad gateway', { status: 502 }));
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/verify-attribution/${VALID_HASH}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { note?: string; verified: boolean } };
    expect(body.data.verified).toBe(false);
    expect(body.data.note).toBe('bundler_unreachable');
  });

  test('verified:false, note:userop_not_found_or_marker_absent when bundler returns empty result', async () => {
    stubFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: null })
    );
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/verify-attribution/${VALID_HASH}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { note?: string; verified: boolean } };
    expect(body.data.verified).toBe(false);
    expect(body.data.note).toBe('userop_not_found_or_marker_absent');
  });

  test('unknown chainId returns 200 with note:chain_not_configured', async () => {
    stubFetch(async () => {
      throw new Error('should not be called');
    });
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/verify-attribution/${VALID_HASH}?chainId=99999999`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { note?: string; verified: boolean } };
    expect(body.data.verified).toBe(false);
    expect(body.data.note).toBe('chain_not_configured');
  });

  test('rate-limit headers present on the route', async () => {
    stubFetch(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: { callData: '0x' + '00'.repeat(80) } })
    );
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/verify-attribution/${VALID_HASH}`,
    });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
  });
});
