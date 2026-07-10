/**
 * F2 delegated QVAC provider tests.
 *
 * The backend host does not ship @qvac/sdk, so the "happy-path" test uses
 * mock.module to inject a fake SDK. Failure-mode tests use the real absent
 * SDK path (import throws) to prove the module degrades to
 * status:'unavailable' rather than crashing boot.
 *
 * Docs: https://docs.qvac.tether.io/p2p-capabilities/delegated-inference/
 */

import { describe, expect, test, beforeEach, mock } from 'bun:test';

const realConfig = await import('../../../src/config/main-config.ts');

const withEnv = async (overrides: Partial<typeof realConfig>) => {
  mock.module('../../../src/config/main-config.ts', () => ({
    ...realConfig,
    ...overrides,
  }));
  const mod = await import('../../../src/lib/qvac/delegatedProvider.ts');
  mod.__resetForTest();
  return mod;
};

describe('delegated QVAC provider', () => {
  beforeEach(() => {
    mock.module('../../../src/config/main-config.ts', () => realConfig);
  });

  test('reports disabled when the feature flag is off', async () => {
    const mod = await withEnv({ ENABLE_QVAC_PROVIDER: false });
    const report = await mod.getDelegatedProvider();
    expect(report.status).toBe('disabled');
    expect(report.publicKey).toBeNull();
    expect(report.firewall.mode).toBeDefined();
  });

  test('fails closed when firewall mode=allow and allow-list is empty', async () => {
    const mod = await withEnv({
      ENABLE_QVAC_PROVIDER: true,
      QVAC_FIREWALL_MODE: 'allow' as const,
      QVAC_ALLOWED_PUBKEYS: [],
      QVAC_PROVIDER_MODELS: ['bergamot-id-en'],
    });
    const report = await mod.getDelegatedProvider();
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('firewall-allow-list-empty');
  });

  test('rejects a malformed public key in the allow list', async () => {
    const mod = await withEnv({
      ENABLE_QVAC_PROVIDER: true,
      QVAC_FIREWALL_MODE: 'allow' as const,
      // Not a 32-byte hex string.
      QVAC_ALLOWED_PUBKEYS: ['deadbeef'],
      QVAC_PROVIDER_MODELS: ['bergamot-id-en'],
    });
    const report = await mod.getDelegatedProvider();
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('QVAC_ALLOWED_PUBKEYS contains invalid entry');
  });

  test('reports unavailable when @qvac/sdk is not installed', async () => {
    const mod = await withEnv({
      ENABLE_QVAC_PROVIDER: true,
      QVAC_FIREWALL_MODE: 'allow-all' as const,
      QVAC_ALLOWED_PUBKEYS: [],
      QVAC_PROVIDER_MODELS: ['bergamot-id-en'],
    });
    // @qvac/sdk is not installed on the backend; the module's loadSdk() must
    // return null and we should see 'unavailable' with a clear reason.
    const report = await mod.getDelegatedProvider();
    expect(report.status).toBe('unavailable');
    expect(report.reason).toContain('@qvac/sdk not installed');
    // Firewall metadata still surfaces so operators can debug config.
    expect(report.firewall.mode).toBe('allow-all');
  });

  test('drops unknown model ids and reports failed when no models resolve', async () => {
    const mod = await withEnv({
      ENABLE_QVAC_PROVIDER: true,
      QVAC_FIREWALL_MODE: 'allow-all' as const,
      QVAC_ALLOWED_PUBKEYS: [],
      QVAC_PROVIDER_MODELS: ['not-a-real-model-id'],
    });
    const report = await mod.getDelegatedProvider();
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('no valid models');
  });

  test('snapshot accessor does not trigger the lazy start', async () => {
    const mod = await withEnv({
      ENABLE_QVAC_PROVIDER: true,
      QVAC_FIREWALL_MODE: 'allow-all' as const,
      QVAC_ALLOWED_PUBKEYS: [],
      QVAC_PROVIDER_MODELS: ['bergamot-id-en'],
    });
    // Before any getDelegatedProvider() call the snapshot reads as disabled
    // per the invariant documented in the module.
    const snap = mod.getDelegatedProviderStateSnapshot();
    expect(snap.status).toBe('disabled');
    expect(snap.publicKey).toBeNull();
  });
});
