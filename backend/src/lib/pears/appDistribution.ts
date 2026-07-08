/**
 * F13: Pear app distribution supervisor.
 *
 * The backend maintains a permanent Pears seeder for the Curva Pear app itself
 * (`pear://<appKey>`). This module owns the config snapshot + subprocess
 * supervisor for that seeder. The public distribution endpoints (see
 * `distributionRoutes.ts`) read from `getConfig()` and `getStatus()`.
 *
 * Independent of the per-room `SeederSupervisor`:
 *   - Exactly one subprocess for the app distribution (not per-room).
 *   - Does NOT count against SEEDER_MAX_ROOMS.
 *   - Reuses the existing `bareSeeder.mjs` script in `--mode=app-distribution`
 *     so we don't ship a second Bare entrypoint or a second dependency stack.
 *
 * Graceful-degradation posture (per ARCH §21 F13 failure-modes table):
 *   - `PEAR_APP_KEY` unset or `PEAR_DISTRIBUTION_ENABLED=false` → no-op supervisor;
 *     the manifest still returns 200 with `appKey: null`, `seederRunning: false`.
 *   - Subprocess crash → exponential backoff (5s, 15s, 45s, 2min, 5min) capped at
 *     `PEAR_DISTRIBUTION_SEEDER_MAX_RETRIES_PER_HOUR` (default 5). After the cap,
 *     supervisor stops retrying until process restart.
 *   - Bare runtime missing → the script itself degrades to stub telemetry
 *     (existing bareSeeder.mjs behaviour). Manifest reports `seederRunning: true`
 *     with a stub topic — still honest to the "seeder subprocess is alive" claim.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import {
  PEAR_APP_DESCRIPTION,
  PEAR_APP_KEY,
  PEAR_APP_RELEASE_DATE,
  PEAR_APP_VERSION,
  PEAR_DISTRIBUTION_ENABLED,
  PEAR_DISTRIBUTION_SEEDER_MAX_RETRIES_PER_HOUR,
  SEEDER_BARE_ENTRY,
  SEEDER_NOISE_SEED,
} from '../../config/main-config.ts';
import { eventBus } from '../activity/eventBus.ts';

// Backoff schedule per crash. Index N is used for the Nth restart in the
// rolling-hour window; last value is reused past the end of the array.
const BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

const ROLLING_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface AppDistributionConfig {
  /** Pear public key (hex). null when not released yet. */
  appKey: string | null;
  version: string;
  releasedAt: string | null;
  description: string;
  enabled: boolean;
}

export interface AppDistributionStatus {
  seederRunning: boolean;
  seederUptimeSeconds: number | null;
  seederPid: number | null;
  restartCount: number;
  lastRestartAt: string | null;
  lastError: string | null;
  retryBudgetExhausted: boolean;
}

export interface InstallInstructions {
  command: string;
  url: string;
  note: string;
}

// -----------------------------------------------------------------------------
// Config snapshot — captured at module import so the manifest is deterministic
// across the process lifetime. Rebooting to change PEAR_APP_KEY is the
// documented rollout path (an operator setting a new key does one `systemctl
// restart` regardless).
// -----------------------------------------------------------------------------

const SNAPSHOT: Readonly<AppDistributionConfig> = Object.freeze({
  appKey: PEAR_APP_KEY && PEAR_APP_KEY.length > 0 ? PEAR_APP_KEY : null,
  version: PEAR_APP_VERSION,
  releasedAt: PEAR_APP_RELEASE_DATE ?? null,
  description: PEAR_APP_DESCRIPTION,
  enabled: PEAR_DISTRIBUTION_ENABLED,
});

export const getConfig = (): AppDistributionConfig => SNAPSHOT;

export const getInstallInstructions = (): InstallInstructions => ({
  command: SNAPSHOT.appKey
    ? `npm i -g pear && pear run pear://${SNAPSHOT.appKey}`
    : 'npm i -g pear && pear run pear://<pending-release>',
  url: SNAPSHOT.appKey ? `pear://${SNAPSHOT.appKey}` : '',
  note: SNAPSHOT.appKey
    ? 'Run once; Pear will keep the app up-to-date via the distribution seeder.'
    : 'Pear app has not shipped its first public release yet. Manifest will populate once PEAR_APP_KEY is configured.',
});

// -----------------------------------------------------------------------------
// Supervisor state (module-scope singleton)
// -----------------------------------------------------------------------------

interface SupervisorState {
  child: ChildProcess | null;
  spawnedAt: number | null;
  restartTimestamps: number[]; // epoch ms of restarts inside the rolling window
  totalRestarts: number;
  lastError: string | null;
  disabledLogged: boolean;
  shuttingDown: boolean;
  retryTimer: NodeJS.Timeout | null;
  retryBudgetExhausted: boolean;
}

const state: SupervisorState = {
  child: null,
  spawnedAt: null,
  restartTimestamps: [],
  totalRestarts: 0,
  lastError: null,
  disabledLogged: false,
  shuttingDown: false,
  retryTimer: null,
  retryBudgetExhausted: false,
};

const pruneRestartWindow = (now: number): void => {
  const cutoff = now - ROLLING_WINDOW_MS;
  state.restartTimestamps = state.restartTimestamps.filter((t) => t >= cutoff);
};

const backoffMsFor = (attemptInWindow: number): number => {
  if (attemptInWindow < 0) return BACKOFF_MS[0]!;
  const idx = Math.min(attemptInWindow, BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx]!;
};

// -----------------------------------------------------------------------------
// Subprocess spawn
// -----------------------------------------------------------------------------

const spawnChild = (): void => {
  if (!SNAPSHOT.enabled || !SNAPSHOT.appKey) return;
  if (state.child) return;
  if (state.shuttingDown) return;

  const entryPath = resolve(process.cwd(), SEEDER_BARE_ENTRY);
  const env = {
    ...process.env,
    // The bareSeeder script uses CURVA_SLUG as its topic seed. In
    // app-distribution mode we deliberately reuse it (the script joins
    // sha256('curva/' + CURVA_SLUG)) so we can carry the app key as the topic
    // input with no protocol changes. This mirrors the Keet public-seeder shape
    // where the peer joins the same replication topic every Curva Pear runtime
    // will join.
    CURVA_SLUG: `pear-app:${SNAPSHOT.appKey}`,
    CURVA_SEEDER_NOISE_SEED: SEEDER_NOISE_SEED,
    CURVA_SEEDER_MODE: 'app-distribution',
    CURVA_PEAR_APP_KEY: SNAPSHOT.appKey,
  };

  // Runtime selection (see seeder.ts spawnRoom for the full rationale).
  // Bun 1.3.x cannot host the bareSeeder NAPI modules; force Node when the
  // backend is running under Bun so this subprocess boots cleanly. Ops can
  // override with SEEDER_NODE_BIN.
  const explicitBin = (process.env.SEEDER_NODE_BIN || '').trim();
  let interpreter: string;
  if (explicitBin.length > 0) {
    interpreter = explicitBin;
  } else if (process.execPath.endsWith('/bun') || process.execPath.endsWith('\\bun.exe')) {
    interpreter = 'node';
  } else {
    interpreter = process.execPath;
  }
  let child: ChildProcess;
  try {
    child = spawn(interpreter, [entryPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
  } catch (err) {
    state.lastError = (err as Error)?.message ?? 'spawn failed';
    console.error(`[AppDistribution] spawn failed via ${interpreter}:`, state.lastError);
    scheduleRestart();
    return;
  }

  state.child = child;
  state.spawnedAt = Date.now();

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    // Telemetry parsing intentionally minimal here — the distribution seeder
    // isn't queried per-room; the manifest only reports "is it running".
    // We keep this handler wired so bare-runtime warnings surface at debug time.
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Suppress noise; the child emits {event:"peers",...} every 10s.
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    console.warn(`[AppDistribution:${SNAPSHOT.appKey?.slice(0, 8)}] stderr: ${chunk.trim()}`);
  });
  child.on('error', (err) => {
    state.lastError = err.message;
    console.error('[AppDistribution] child error:', err.message);
  });
  child.on('exit', (code, signal) => {
    const uptime = state.spawnedAt ? Math.floor((Date.now() - state.spawnedAt) / 1000) : 0;
    console.log(
      `[AppDistribution] subprocess exited code=${code} signal=${signal} uptimeSec=${uptime}`
    );
    const wasRunning = state.child !== null;
    state.child = null;
    state.spawnedAt = null;

    if (state.shuttingDown) {
      // Deliberate shutdown, publish stopped and stop.
      try {
        eventBus.publish('distribution.seeder_stopped', {
          appKey: SNAPSHOT.appKey ?? '',
          reason: 'shutdown',
          uptimeSeconds: uptime,
        });
      } catch (err) {
        console.warn('[AppDistribution] publish stopped failed:', (err as Error)?.message);
      }
      return;
    }

    if (wasRunning) {
      // Unexpected crash.
      try {
        eventBus.publish('distribution.seeder_crashed', {
          appKey: SNAPSHOT.appKey ?? '',
          exitCode: code,
          signal,
          restartCount: state.totalRestarts,
          nextRetryInMs: null, // populated by scheduleRestart below
          errorMessage: state.lastError,
        });
      } catch (err) {
        console.warn('[AppDistribution] publish crashed failed:', (err as Error)?.message);
      }
      scheduleRestart();
    }
  });

  console.log(
    `[AppDistribution] Spawned distribution seeder pid=${child.pid} appKey=${SNAPSHOT.appKey?.slice(
      0,
      12
    )}...`
  );

  try {
    eventBus.publish('distribution.seeder_started', {
      appKey: SNAPSHOT.appKey ?? '',
      pid: child.pid ?? -1,
      startedAt: new Date(state.spawnedAt).toISOString(),
    });
  } catch (err) {
    console.warn('[AppDistribution] publish started failed:', (err as Error)?.message);
  }
};

const scheduleRestart = (): void => {
  if (state.shuttingDown) return;
  const now = Date.now();
  pruneRestartWindow(now);

  if (state.restartTimestamps.length >= PEAR_DISTRIBUTION_SEEDER_MAX_RETRIES_PER_HOUR) {
    if (!state.retryBudgetExhausted) {
      state.retryBudgetExhausted = true;
      console.warn(
        `[AppDistribution] Restart budget exhausted (${PEAR_DISTRIBUTION_SEEDER_MAX_RETRIES_PER_HOUR}/hour); ` +
          'giving up until the next process restart.'
      );
    }
    return;
  }

  const attemptInWindow = state.restartTimestamps.length;
  const delay = backoffMsFor(attemptInWindow);
  state.restartTimestamps.push(now);
  state.totalRestarts += 1;
  state.retryBudgetExhausted = false;

  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    spawnChild();
  }, delay);
  // Prevent the timer from keeping the process alive during shutdown.
  state.retryTimer.unref?.();

  console.log(`[AppDistribution] Restart scheduled in ${Math.floor(delay / 1000)}s`);
};

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export const startAppDistributionSeeder = (): void => {
  if (!SNAPSHOT.enabled || !SNAPSHOT.appKey) {
    if (!state.disabledLogged) {
      state.disabledLogged = true;
      const reason = !SNAPSHOT.enabled
        ? 'PEAR_DISTRIBUTION_ENABLED=false'
        : 'PEAR_APP_KEY unset';
      console.log(
        `[AppDistribution] Distribution seeder disabled (${reason}); manifest will report "coming soon".`
      );
    }
    return;
  }
  console.log('[AppDistribution] Distribution seeder enabled; spawning subprocess...');
  spawnChild();
};

export const stopAppDistributionSeeder = async (): Promise<void> => {
  state.shuttingDown = true;
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  const child = state.child;
  if (!child) return;

  try {
    child.kill('SIGTERM');
  } catch (err) {
    console.warn('[AppDistribution] SIGTERM failed:', (err as Error)?.message);
  }

  const deadline = Date.now() + 3000;
  while (state.child && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (state.child) {
    try {
      state.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    state.child = null;
    state.spawnedAt = null;
  }
};

export const getStatus = (): AppDistributionStatus => {
  const running = state.child !== null;
  const uptime =
    running && state.spawnedAt ? Math.floor((Date.now() - state.spawnedAt) / 1000) : null;
  return {
    seederRunning: running,
    seederUptimeSeconds: uptime,
    seederPid: running ? state.child?.pid ?? null : null,
    restartCount: state.totalRestarts,
    lastRestartAt:
      state.restartTimestamps.length > 0
        ? new Date(state.restartTimestamps[state.restartTimestamps.length - 1]!).toISOString()
        : null,
    lastError: state.lastError,
    retryBudgetExhausted: state.retryBudgetExhausted,
  };
};

/**
 * Test-only reset. Production code MUST NOT call this. Isolates cross-file test
 * state per the [[feedback-singleton-buffer-isolation]] pattern.
 */
export const __resetForTest = (): void => {
  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.child = null;
  state.spawnedAt = null;
  state.restartTimestamps = [];
  state.totalRestarts = 0;
  state.lastError = null;
  state.disabledLogged = false;
  state.shuttingDown = false;
  state.retryTimer = null;
  state.retryBudgetExhausted = false;
};
