/**
 * Fix Wave B / T3 route test: GET /wdk/token-domain
 *
 * Stubs the eip3009 module so we never touch a real RPC provider. Covers the
 * shape contract the Pear-app wallet depends on (chainId + tokenAddress + name
 * + version), the four error paths (missing/invalid inputs, unknown chain,
 * disabled chain, RPC failure, missing name()), and the 200 happy path.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

// -----------------------------------------------------------------------------
// Stub the eip3009 domain fetcher BEFORE importing the route.
// -----------------------------------------------------------------------------

interface StubDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

const SEPOLIA_USDT = '0xd077a400968890eacc75cdc901f0356c943e4fdb';

let stubResponse: StubDomain | null = {
  name: 'USDT',
  version: '1',
  chainId: 11155111,
  verifyingContract: SEPOLIA_USDT,
};
let stubThrows: Error | null = null;

const eip3009Module = await import('../../src/lib/evm/eip3009.ts');

mock.module('../../src/lib/evm/eip3009.ts', () => ({
  ...eip3009Module,
  fetchEip3009Domain: async () => {
    if (stubThrows) throw stubThrows;
    return stubResponse;
  },
}));

// NOTE: we deliberately do NOT mock chains.ts here. The real static config
// (backend/src/data/chains.json) already ships Sepolia (11155111, enabled) +
// Plasma (9746, enabled=false), which is exactly the shape this route needs.
// Mocking chains.ts would leak into chains.test.ts (see [[feedback_test_module_mocks]]).

const { tokenDomainRoutes } = await import('../../src/routes/tokenDomainRoutes.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(tokenDomainRoutes, { prefix: '/wdk' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /wdk/token-domain — validation', () => {
  test('400 when chainId is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/token-domain?token=${SEPOLIA_USDT}`,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR'
    );
  });

  test('400 when chainId is not an integer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/token-domain?chainId=abc&token=${SEPOLIA_USDT}`,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR'
    );
  });

  test('400 when token is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/wdk/token-domain?chainId=11155111',
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR'
    );
  });

  test('400 when token is malformed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/wdk/token-domain?chainId=11155111&token=not-hex',
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'VALIDATION_ERROR'
    );
  });

  test('400 UNKNOWN_CHAIN for an unregistered chainId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/token-domain?chainId=999999&token=${SEPOLIA_USDT}`,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'UNKNOWN_CHAIN'
    );
  });

  test('400 CHAIN_DISABLED when the chain is known but disabled', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/token-domain?chainId=9746&token=${SEPOLIA_USDT}`,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'CHAIN_DISABLED'
    );
  });
});

describe('GET /wdk/token-domain — happy path', () => {
  test('200 returns { name, version, chainId, tokenAddress, fetchedAt }', async () => {
    stubResponse = {
      name: 'USDT',
      version: '1',
      chainId: 11155111,
      verifyingContract: SEPOLIA_USDT,
    };
    stubThrows = null;
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/token-domain?chainId=11155111&token=${SEPOLIA_USDT}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: {
        chainId: number;
        tokenAddress: string;
        name: string;
        version: string;
        fetchedAt: string;
      };
    };
    expect(body.data.chainId).toBe(11155111);
    expect(body.data.tokenAddress).toBe(SEPOLIA_USDT);
    expect(body.data.name).toBe('USDT');
    expect(body.data.version).toBe('1');
    expect(typeof body.data.fetchedAt).toBe('string');
    // ISO timestamp round-trips.
    expect(Number.isNaN(Date.parse(body.data.fetchedAt))).toBe(false);
  });

  test('200 handles non-standard version strings ("2") transparently', async () => {
    stubResponse = {
      name: 'Tether USD',
      version: '2',
      chainId: 11155111,
      verifyingContract: SEPOLIA_USDT,
    };
    stubThrows = null;
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/token-domain?chainId=11155111&token=${SEPOLIA_USDT}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { name: string; version: string } };
    expect(body.data.name).toBe('Tether USD');
    expect(body.data.version).toBe('2');
  });
});

describe('GET /wdk/token-domain — upstream errors', () => {
  test('404 TOKEN_DOMAIN_UNAVAILABLE when probe returns null', async () => {
    stubResponse = null;
    stubThrows = null;
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/token-domain?chainId=11155111&token=${SEPOLIA_USDT}`,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'TOKEN_DOMAIN_UNAVAILABLE'
    );
  });

  test('503 RPC_UNAVAILABLE with Retry-After header when probe throws', async () => {
    stubResponse = null;
    stubThrows = new Error('RPC unreachable');
    const res = await app.inject({
      method: 'GET',
      url: `/wdk/token-domain?chainId=11155111&token=${SEPOLIA_USDT}`,
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'RPC_UNAVAILABLE'
    );
    expect(res.headers['retry-after']).toBe('30');
    // Reset so later tests aren't polluted.
    stubThrows = null;
  });
});
