/**
 * Fiat pricing endpoint (Wave 7 Zone C).
 *
 *   GET /pricing/usdt?currency=IDR
 *
 * Returns:
 *   { rate, source, currency, fetchedAt, stale, assumption? }
 *
 * `rate` is the number of `currency` units per 1 USDT. Renderers multiply
 * their tip amount by this number to show a fiat sanity chip.
 *
 * Rate limit: 60 req/min/IP. The upstream is aggressively cached (60s) so
 * per-IP throttling caps abuse without hurting legit clients that refresh on
 * every room open.
 *
 * Cache-Control: max-age=60 mirrors the in-memory cache so intermediate
 * proxies (nginx, Fly.io edge) can share responses across clients.
 *
 * Failure modes:
 *  - Unknown currency  -> 400 UNSUPPORTED_CURRENCY (allowlist only).
 *  - Upstream down + no cached value -> 503 PRICING_UNAVAILABLE (via handleError).
 *  - Upstream down + stale cache     -> 200 with `stale: true` (fail-open).
 *
 * Security:
 *  - No secrets touched.
 *  - Currency is validated against a hard allowlist so it's impossible to
 *    inject arbitrary strings into the upstream URL (defense-in-depth even
 *    though the URL is a constant).
 *  - Generic error message to clients; upstream error detail stays in logs.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  getUsdtQuote,
  isSupportedCurrency,
  SUPPORTED_CURRENCIES,
} from '../lib/pricing/bitfinex.ts';
import {
  PRICING_RATE_LIMIT_MAX,
  PRICING_RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';

const RATE_LIMIT_CFG = {
  rateLimit: {
    max: PRICING_RATE_LIMIT_MAX,
    timeWindow: PRICING_RATE_LIMIT_WINDOW,
  },
};

export const pricingRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/usdt',
    { config: RATE_LIMIT_CFG },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = (request.query || {}) as Record<string, unknown>;
      const raw = typeof q.currency === 'string' ? q.currency.toUpperCase() : '';

      if (!isSupportedCurrency(raw)) {
        return handleError(
          reply,
          400,
          `Unsupported currency. Allowed: ${SUPPORTED_CURRENCIES.join(', ')}`,
          'UNSUPPORTED_CURRENCY',
          null,
          { received: raw }
        );
      }

      try {
        const quote = await getUsdtQuote(raw);
        // 60s max-age so nginx / Fly.io edge can share a single response
        // across the fleet. Stale-while-revalidate keeps the UI snappy after
        // a cache miss — the browser gets the stale value instantly and
        // refreshes it in the background.
        reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
        return reply.code(200).send({ success: true, error: null, data: quote });
      } catch (err) {
        // Fail-loud path: cache empty AND upstream down. 503 is more honest
        // than 500 because clients can retry after Retry-After.
        reply.header('Retry-After', '30');
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
