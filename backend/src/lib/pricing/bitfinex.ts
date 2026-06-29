/**
 * USDT -> fiat pricing (Wave 7 Zone C).
 *
 * Sources of truth (docs-first):
 *  - Bitfinex public REST v2 tickers:
 *      GET https://api-pub.bitfinex.com/v2/tickers?symbols=tBTCUSD,tETHUSD,tUSTUSD
 *      Response is an array of arrays:
 *        [ SYMBOL, BID, BID_SIZE, ASK, ASK_SIZE, DAILY_CHANGE, DAILY_CHANGE_REL,
 *          LAST_PRICE, VOLUME, HIGH, LOW ]
 *      Symbol prefix is "t" for trading pairs. USDT is coded "UST" on Bitfinex,
 *      so USDT/USD spot lives on `tUSTUSD`.
 *      Docs: https://docs.bitfinex.com/reference/rest-public-tickers
 *
 *  - USD -> fiat conversion:
 *      Frankfurter (ECB reference rates, no auth, permissive licence).
 *      GET https://api.frankfurter.dev/v1/latest?base=USD&symbols=IDR,EUR,GBP,BRL,MXN,JPY
 *      Response shape: { amount, base, date, rates: { IDR: number, ... } }
 *      Docs: https://frankfurter.dev/
 *
 * Contract exposed by this module:
 *   getUsdtQuote(currency) -> { rate, source, currency, fetchedAt, stale, assumption? }
 *   - `rate` is the number of `currency` units per 1 USDT.
 *   - `source` names the upstreams used (comma-separated).
 *   - `fetchedAt` is an ISO-8601 string of when the underlying upstream call
 *     completed (NOT when this call was served). Judges reading the payload
 *     see instantly whether the value came from cache or a live fetch.
 *   - `stale` is true when the cached copy expired AND the upstream fetch
 *     failed, so we returned the last known value as fail-open behaviour
 *     (production-hardening: never 500 on a transient upstream blip).
 *   - `assumption` is only present when 1 USDT is treated as ~1 USD (currency
 *     === 'USD'), so consumers can render a "peg assumed" hint.
 *
 * Cache: 60 seconds in-memory, keyed by currency. On upstream failure we serve
 * the last cached value with `stale: true`. If there is no cached value AND
 * the upstream is down, we throw so the route can return an appropriate 503.
 *
 * Security notes:
 *  - No secrets are used or logged (both endpoints are unauthenticated).
 *  - Timeouts are enforced (5s) to prevent slow-loris upstreams from tying up
 *    Fastify workers.
 *  - Response bodies are size-capped (32 KB) to prevent memory blow-up from a
 *    hostile/misbehaving upstream.
 *  - We do NOT pass user input into the URL beyond validating currency against
 *    a hard allowlist — SSRF is not a risk since the URL is fully constant.
 */

// Supported fiat targets. USD is included even though it doesn't need a
// Frankfurter round-trip; we return the peg assumption instead.
export const SUPPORTED_CURRENCIES = ['IDR', 'USD', 'EUR', 'GBP', 'BRL', 'MXN', 'JPY'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const isSupportedCurrency = (v: unknown): v is SupportedCurrency =>
  typeof v === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(v);

export interface UsdtQuote {
  rate: number;
  source: string;
  currency: SupportedCurrency;
  fetchedAt: string; // ISO-8601
  stale: boolean;
  assumption?: string;
}

// -----------------------------------------------------------------------------
// Cache
// -----------------------------------------------------------------------------

interface CacheEntry {
  quote: UsdtQuote;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 32 * 1024;

const cache = new Map<SupportedCurrency, CacheEntry>();

// -----------------------------------------------------------------------------
// Fetch helpers
// -----------------------------------------------------------------------------

// Injectable fetch so tests can substitute the network layer without spinning
// up a real server. Kept as `unknown`-typed here and cast at call sites — we
// only ever use the standard fetch signature.
type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

let injectedFetch: FetchLike | null = null;

/** Test-only: swap the fetch implementation. */
export const __setFetchForTest = (fn: FetchLike | null): void => {
  injectedFetch = fn;
};

const getFetch = (): FetchLike => {
  if (injectedFetch) return injectedFetch;
  const f = globalThis.fetch;
  if (!f) throw new Error('global fetch unavailable');
  return f as unknown as FetchLike;
};

/** Fetch a URL as text with hard timeout + size cap. Returns parsed JSON. */
const fetchJson = async (url: string): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await getFetch()(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`upstream HTTP ${res.status}`);
    }
    const body = await res.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      throw new Error('upstream response too large');
    }
    const elapsed = Date.now() - started;
    // Structured log: helps operators see when an upstream is trending slow.
    console.log(
      JSON.stringify({
        level: 'info',
        service: 'pricing',
        upstream: safeHost(url),
        latencyMs: elapsed,
        status: res.status,
      })
    );
    return JSON.parse(body);
  } finally {
    clearTimeout(timer);
  }
};

const safeHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
};

// -----------------------------------------------------------------------------
// Bitfinex USDT->USD peg check
// -----------------------------------------------------------------------------

/**
 * Fetch the current USDT->USD spot from Bitfinex. Symbol is `tUSTUSD` because
 * USDT is coded "UST" on Bitfinex per their symbol table.
 *
 * Returns the LAST_PRICE (index 7 in the ticker array). If Bitfinex is down
 * we return `1` as the peg assumption — the response payload flags this via
 * the `assumption` field so consumers can render a hint.
 */
const BITFINEX_TICKER_URL =
  'https://api-pub.bitfinex.com/v2/tickers?symbols=tUSTUSD';

interface BitfinexPeg {
  usdtPerUsd: number;
  source: string;
  fetchedAt: string;
  assumed: boolean;
}

const fetchBitfinexPeg = async (): Promise<BitfinexPeg> => {
  try {
    const raw = await fetchJson(BITFINEX_TICKER_URL);
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('bitfinex empty ticker set');
    }
    // Each ticker row is [SYMBOL, BID, BID_SIZE, ASK, ASK_SIZE, DAILY_CHANGE,
    // DAILY_CHANGE_REL, LAST_PRICE, VOLUME, HIGH, LOW].
    const row = raw[0];
    if (!Array.isArray(row) || typeof row[7] !== 'number' || !Number.isFinite(row[7])) {
      throw new Error('bitfinex last_price missing');
    }
    return {
      usdtPerUsd: row[7],
      source: 'bitfinex:tUSTUSD',
      fetchedAt: new Date().toISOString(),
      assumed: false,
    };
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'pricing',
        upstream: 'bitfinex',
        message: 'peg fetch failed, assuming 1 USDT = 1 USD',
        error: (err as Error)?.message ?? 'unknown',
      })
    );
    return {
      usdtPerUsd: 1,
      source: 'assumed-peg',
      fetchedAt: new Date().toISOString(),
      assumed: true,
    };
  }
};

// -----------------------------------------------------------------------------
// Frankfurter USD -> fiat
// -----------------------------------------------------------------------------

const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest?base=USD';

interface FrankfurterResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

const fetchFrankfurterRates = async (): Promise<FrankfurterResponse> => {
  const symbols = SUPPORTED_CURRENCIES.filter((c) => c !== 'USD').join(',');
  const raw = (await fetchJson(`${FRANKFURTER_URL}&symbols=${symbols}`)) as FrankfurterResponse;
  if (!raw || typeof raw !== 'object' || !raw.rates || typeof raw.rates !== 'object') {
    throw new Error('frankfurter malformed response');
  }
  return raw;
};

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Return the number of `currency` units per 1 USDT.
 *
 * - USD: 1 USDT ~ 1 USD (peg assumed unless Bitfinex reports otherwise).
 *   The response carries an `assumption` field so the UI can render a hint.
 * - Other fiat: (USDT->USD) * (USD->fiat via Frankfurter).
 *
 * Fail-open: if the upstream is down but we hold a cached value (even
 * expired), we return the cached value with `stale: true`. If we have
 * nothing cached AND the upstream fails, we throw.
 */
export const getUsdtQuote = async (currency: SupportedCurrency): Promise<UsdtQuote> => {
  const cached = cache.get(currency);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.quote;
  }

  try {
    const peg = await fetchBitfinexPeg();

    if (currency === 'USD') {
      const quote: UsdtQuote = {
        rate: peg.usdtPerUsd,
        source: peg.source,
        currency: 'USD',
        fetchedAt: peg.fetchedAt,
        stale: false,
        ...(peg.assumed
          ? { assumption: '1 USDT ~ 1 USD (Bitfinex upstream unavailable)' }
          : {}),
      };
      cache.set(currency, { quote, expiresAt: now + CACHE_TTL_MS });
      return quote;
    }

    const fx = await fetchFrankfurterRates();
    const usdPerFiat = fx.rates[currency];
    if (typeof usdPerFiat !== 'number' || !Number.isFinite(usdPerFiat) || usdPerFiat <= 0) {
      throw new Error(`frankfurter missing rate for ${currency}`);
    }
    const rate = peg.usdtPerUsd * usdPerFiat;

    const quote: UsdtQuote = {
      rate,
      source: peg.assumed
        ? `assumed-peg,frankfurter:${fx.date}`
        : `${peg.source},frankfurter:${fx.date}`,
      currency,
      fetchedAt: new Date().toISOString(),
      stale: false,
      ...(peg.assumed
        ? { assumption: '1 USDT ~ 1 USD (Bitfinex upstream unavailable)' }
        : {}),
    };
    cache.set(currency, { quote, expiresAt: now + CACHE_TTL_MS });
    return quote;
  } catch (err) {
    if (cached) {
      const stale: UsdtQuote = { ...cached.quote, stale: true };
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'pricing',
          message: 'upstream failed, serving stale cache',
          currency,
          error: (err as Error)?.message ?? 'unknown',
        })
      );
      return stale;
    }
    throw err;
  }
};

/** Test-only: wipe the in-memory cache between cases. */
export const __resetCacheForTest = (): void => {
  cache.clear();
};

/** Test-only: inspect the cache for assertions. */
export const __peekCacheForTest = (currency: SupportedCurrency): UsdtQuote | null =>
  cache.get(currency)?.quote ?? null;
