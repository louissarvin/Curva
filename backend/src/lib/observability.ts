/**
 * Backend Prometheus registry + counter surface (Wave 3 F3).
 *
 * This module owns a dedicated prom-client Registry (not the default global
 * one) so the backend's counters are strictly disjoint from any library that
 * happens to also import prom-client. Metric names use the `curva_backend_`
 * prefix so a dashboard operator can distinguish backend metrics from the
 * Pear app's hypercore/swarm/dht/trace metrics (which use the neutral
 * hypercore_*, hyperswarm_*, dht_*, trace_counter names).
 *
 * Docs consulted (fetched 2026-07-10):
 *   https://github.com/siimon/prom-client
 *   https://prometheus.io/docs/practices/naming/
 *   https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
 *
 * Design notes:
 *   1. Feature-flag gate: ENABLE_BACKEND_METRICS=true. When disabled the
 *      counters are no-op objects so hot paths do not need to null-check.
 *   2. Registry is scoped: never uses `promClient.register` (default). This
 *      keeps a future accidental `collectDefaultMetrics()` call from
 *      polluting our /metrics response.
 *   3. Label cardinality control: labels are enum-like (peer id shortened,
 *      model id from static registry, tool name from static enum). We never
 *      accept arbitrary user input as a label — this is the #1 source of
 *      Prometheus OOM.
 *   4. Lazy require: prom-client is loaded via a try/catch so a missing dep
 *      degrades to no-op (matches the Pear-app pattern in bare/observability.js).
 */

import { ENABLE_BACKEND_METRICS } from '../config/main-config.ts';

// -----------------------------------------------------------------------------
// prom-client lazy load
// -----------------------------------------------------------------------------

type PromClient = typeof import('prom-client');

let _promMod: PromClient | null = null;
let _promLoadFailed = false;

const loadProm = (): PromClient | null => {
  if (_promMod) return _promMod;
  if (_promLoadFailed) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('prom-client') as PromClient;
    _promMod = mod;
    return mod;
  } catch {
    _promLoadFailed = true;
    return null;
  }
};

// -----------------------------------------------------------------------------
// Registry — one per process, lazily initialised so tests can control the
// timing. Callers get it via `getRegistry()`.
// -----------------------------------------------------------------------------

interface CounterLike {
  inc(labels?: Record<string, string | number>, value?: number): void;
}

interface HistogramLike {
  observe(labels: Record<string, string | number>, value: number): void;
}

const noopCounter: CounterLike = { inc() {} };
const noopHistogram: HistogramLike = { observe() {} };

interface BackendMetrics {
  delegatedRequestsTotal: CounterLike;
  sponsorTxTotal: CounterLike;
  ragSearchTotal: CounterLike;
  mcpToolCallTotal: CounterLike;
  httpRequestDuration: HistogramLike;
}

interface RegistryState {
  registry: unknown;
  metrics: BackendMetrics;
}

let _state: RegistryState | null = null;

const NOOP_METRICS: BackendMetrics = {
  delegatedRequestsTotal: noopCounter,
  sponsorTxTotal: noopCounter,
  ragSearchTotal: noopCounter,
  mcpToolCallTotal: noopCounter,
  httpRequestDuration: noopHistogram,
};

const bootstrap = (): RegistryState | null => {
  if (_state) return _state;
  if (!ENABLE_BACKEND_METRICS) return null;
  const prom = loadProm();
  if (!prom) return null;

  const registry = new prom.Registry();

  // Sensible default labels for cross-service dashboards.
  registry.setDefaultLabels({ service: 'curva-companion' });

  // Emit process-level metrics (heap, event loop lag) on this registry so a
  // single scrape covers app health + business counters. Bounded overhead
  // (~1ms per scrape per prom-client docs).
  prom.collectDefaultMetrics({ register: registry });

  const delegatedRequestsTotal = new prom.Counter({
    name: 'curva_backend_delegated_requests_total',
    help: 'QVAC delegated-inference requests served by the backend (F2).',
    labelNames: ['peer', 'model', 'outcome'],
    registers: [registry],
  });

  const sponsorTxTotal = new prom.Counter({
    name: 'curva_backend_sponsor_tx_total',
    help: 'EIP-3009 sponsor relay transactions (F11).',
    labelNames: ['status', 'chain'],
    registers: [registry],
  });

  const ragSearchTotal = new prom.Counter({
    name: 'curva_backend_rag_search_total',
    help: 'Shared WC26 RAG search invocations (F4).',
    labelNames: ['corpus', 'outcome'],
    registers: [registry],
  });

  const mcpToolCallTotal = new prom.Counter({
    name: 'curva_backend_mcp_tool_call_total',
    help: 'MCP tools/call invocations broken out by tool name.',
    labelNames: ['tool', 'outcome'],
    registers: [registry],
  });

  const httpRequestDuration = new prom.Histogram({
    name: 'curva_backend_http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route', 'status'],
    // Practical latency buckets for a JSON API: 5ms to 5s.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  _state = {
    registry,
    metrics: {
      delegatedRequestsTotal,
      sponsorTxTotal,
      ragSearchTotal,
      mcpToolCallTotal,
      httpRequestDuration,
    },
  };
  return _state;
};

export const getBackendMetrics = (): BackendMetrics => {
  const s = bootstrap();
  return s ? s.metrics : NOOP_METRICS;
};

/**
 * Serialise the registry to Prometheus text format. Returns null when metrics
 * are disabled OR prom-client is unavailable — the /metrics route should then
 * return 404 (hide-existence per ADR-010) rather than an empty body.
 */
export const scrapeMetrics = async (): Promise<{ body: string; contentType: string } | null> => {
  const s = bootstrap();
  if (!s) return null;
  const registry = s.registry as { metrics: () => Promise<string>; contentType: string };
  return { body: await registry.metrics(), contentType: registry.contentType };
};

/**
 * Sanitise a label value so cardinality stays bounded and we never accept
 * arbitrary user input. Never returns an empty string (Prometheus is fine
 * with empty labels but they signal a misuse we want to catch in dashboards).
 */
export const boundedLabel = (v: unknown, maxLen = 48): string => {
  if (typeof v !== 'string') return 'unknown';
  const trimmed = v.slice(0, maxLen).replace(/[^A-Za-z0-9._:-]/g, '_');
  return trimmed || 'unknown';
};

/**
 * Convenience helpers for the four counter surfaces the rest of the codebase
 * will call. Kept as tiny functions so hot paths (RAG search, MCP tool call)
 * do not have to null-check `getBackendMetrics()` themselves.
 */
export const recordDelegatedRequest = (
  peer: string,
  model: string,
  outcome: 'ok' | 'error' | 'denied'
): void => {
  getBackendMetrics().delegatedRequestsTotal.inc({
    peer: boundedLabel(peer, 16),
    model: boundedLabel(model),
    outcome,
  });
};

export const recordSponsorTx = (
  status: 'submitted' | 'confirmed' | 'failed',
  chainId: number
): void => {
  getBackendMetrics().sponsorTxTotal.inc({
    status,
    chain: boundedLabel(String(chainId), 16),
  });
};

export const recordRagSearch = (
  corpus: string,
  outcome: 'hit' | 'miss' | 'error'
): void => {
  getBackendMetrics().ragSearchTotal.inc({
    corpus: boundedLabel(corpus, 32),
    outcome,
  });
};

export const recordMcpToolCall = (
  tool: string,
  outcome: 'ok' | 'error'
): void => {
  getBackendMetrics().mcpToolCallTotal.inc({
    tool: boundedLabel(tool, 48),
    outcome,
  });
};

// -----------------------------------------------------------------------------
// Test-only reset (matches the pattern used by src/lib/qvac/registry.ts).
// -----------------------------------------------------------------------------
export const __resetForTest = (): void => {
  _state = null;
  _promMod = null;
  _promLoadFailed = false;
};
