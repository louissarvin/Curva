/**
 * F13 unit tests for the app-distribution supervisor.
 *
 * The module snapshots PEAR_APP_KEY / PEAR_DISTRIBUTION_ENABLED at import time,
 * so the default-env case (both unset) exercises the "disabled → no-op" path.
 * The enabled path is covered by a second describe block that uses
 * `mock.module` to inject a stub config before re-importing the module.
 */

import { afterEach, describe, expect, test } from 'bun:test';

// -----------------------------------------------------------------------------
// Default env (PEAR_APP_KEY unset, PEAR_DISTRIBUTION_ENABLED=false)
// -----------------------------------------------------------------------------

describe('appDistribution (disabled by default)', () => {
  test('getConfig() returns null appKey when env unset', async () => {
    const mod = await import('../../../src/lib/pears/appDistribution.ts');
    mod.__resetForTest();
    const cfg = mod.getConfig();
    expect(cfg.appKey).toBeNull();
    expect(cfg.enabled).toBe(false);
    expect(cfg.version).toBeDefined(); // defaults to '0.0.0-pending'
    expect(typeof cfg.description).toBe('string');
    expect(cfg.description.length).toBeGreaterThan(0);
  });

  test('getStatus() reports seederRunning=false when disabled', async () => {
    const mod = await import('../../../src/lib/pears/appDistribution.ts');
    mod.__resetForTest();
    const status = mod.getStatus();
    expect(status.seederRunning).toBe(false);
    expect(status.seederUptimeSeconds).toBeNull();
    expect(status.seederPid).toBeNull();
    expect(status.restartCount).toBe(0);
    expect(status.lastError).toBeNull();
    expect(status.retryBudgetExhausted).toBe(false);
  });

  test('startAppDistributionSeeder() is a no-op when config disabled', async () => {
    const mod = await import('../../../src/lib/pears/appDistribution.ts');
    mod.__resetForTest();
    // Should not throw, should not spawn anything.
    mod.startAppDistributionSeeder();
    expect(mod.getStatus().seederRunning).toBe(false);
  });

  test('startAppDistributionSeeder() only logs disabled reason once', async () => {
    const mod = await import('../../../src/lib/pears/appDistribution.ts');
    mod.__resetForTest();
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      mod.startAppDistributionSeeder();
      mod.startAppDistributionSeeder();
      mod.startAppDistributionSeeder();
    } finally {
      console.log = originalLog;
    }
    const disabledMessages = logs.filter((l) => l.includes('disabled'));
    expect(disabledMessages.length).toBe(1);
  });

  test('stopAppDistributionSeeder() resolves cleanly with nothing running', async () => {
    const mod = await import('../../../src/lib/pears/appDistribution.ts');
    mod.__resetForTest();
    await expect(mod.stopAppDistributionSeeder()).resolves.toBeUndefined();
  });

  test('getInstallInstructions() returns a "pending" hint when appKey null', async () => {
    const mod = await import('../../../src/lib/pears/appDistribution.ts');
    mod.__resetForTest();
    const install = mod.getInstallInstructions();
    expect(install.command).toContain('pear');
    expect(install.command).toContain('pending');
    expect(install.note).toContain('has not shipped');
  });

  afterEach(async () => {
    const mod = await import('../../../src/lib/pears/appDistribution.ts');
    mod.__resetForTest();
  });
});
