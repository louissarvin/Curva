/**
 * F3 backend Prometheus observability tests.
 *
 * Verified against installed prom-client@15 (node_modules/prom-client) and
 * OWASP Logging Cheat Sheet guidance about restricting telemetry endpoints.
 */

import { describe, expect, test, beforeEach, mock } from 'bun:test';

const realConfig = await import('../../src/config/main-config.ts');

const loadWithFlag = async (enabled: boolean) => {
  mock.module('../../src/config/main-config.ts', () => ({
    ...realConfig,
    ENABLE_BACKEND_METRICS: enabled,
  }));
  const mod = await import('../../src/lib/observability.ts');
  mod.__resetForTest();
  return mod;
};

describe('backend observability', () => {
  beforeEach(() => {
    // Ensure a clean slate before each test.
    mock.module('../../src/config/main-config.ts', () => realConfig);
  });

  test('scrapeMetrics returns null when the feature flag is off', async () => {
    const mod = await loadWithFlag(false);
    const scrape = await mod.scrapeMetrics();
    expect(scrape).toBeNull();
    // No-op counters must still be callable — hot paths should never crash.
    expect(() => mod.recordDelegatedRequest('peer1', 'whisper', 'ok')).not.toThrow();
    expect(() => mod.recordSponsorTx('confirmed', 11155111)).not.toThrow();
    expect(() => mod.recordRagSearch('wc26', 'hit')).not.toThrow();
    expect(() => mod.recordMcpToolCall('score.getLive', 'ok')).not.toThrow();
  });

  test('scrapeMetrics returns the Prometheus text body when enabled', async () => {
    const mod = await loadWithFlag(true);
    mod.recordDelegatedRequest('peer_abc', 'bergamot-id-en', 'ok');
    mod.recordSponsorTx('confirmed', 11155111);
    mod.recordRagSearch('wc26', 'hit');
    mod.recordMcpToolCall('score.getLive', 'ok');
    const scrape = await mod.scrapeMetrics();
    expect(scrape).not.toBeNull();
    if (!scrape) throw new Error('unreachable');
    expect(scrape.contentType).toContain('text/plain');
    // All four counter families appear on /metrics.
    expect(scrape.body).toContain('curva_backend_delegated_requests_total');
    expect(scrape.body).toContain('curva_backend_sponsor_tx_total');
    expect(scrape.body).toContain('curva_backend_rag_search_total');
    expect(scrape.body).toContain('curva_backend_mcp_tool_call_total');
    // Sanity check: the default label survived.
    expect(scrape.body).toContain('service="curva-companion"');
  });

  test('boundedLabel strips arbitrary user input to a safe subset', async () => {
    const mod = await loadWithFlag(true);
    // Injecting `\n` into a Prometheus label breaks the exposition format;
    // boundedLabel replaces it with `_`.
    expect(mod.boundedLabel('foo\nbar', 32)).toBe('foo_bar');
    expect(mod.boundedLabel('a'.repeat(80), 16).length).toBe(16);
    expect(mod.boundedLabel(undefined)).toBe('unknown');
    expect(mod.boundedLabel(42)).toBe('unknown');
    // Non-string that stringifies to empty must not produce an empty label.
    expect(mod.boundedLabel('')).toBe('unknown');
  });

  test('increments accumulate across calls', async () => {
    const mod = await loadWithFlag(true);
    for (let i = 0; i < 3; i++) mod.recordRagSearch('wc26', 'hit');
    for (let i = 0; i < 2; i++) mod.recordRagSearch('wc26', 'miss');
    const scrape = await mod.scrapeMetrics();
    expect(scrape).not.toBeNull();
    if (!scrape) throw new Error('unreachable');
    // Look for the labelled series in the text body.
    expect(scrape.body).toMatch(/curva_backend_rag_search_total\{[^}]*outcome="hit"[^}]*\} 3/);
    expect(scrape.body).toMatch(/curva_backend_rag_search_total\{[^}]*outcome="miss"[^}]*\} 2/);
  });
});
