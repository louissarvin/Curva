/**
 * F2 Wave 3: Backend as delegated QVAC provider.
 *
 * Peers with `qvacDelegated: {publicKey: <backend-pubkey>}` in their model
 * registry can offload STT (whisper), NMT (Bergamot), or other compute to
 * this backend. Backend CPU is usually >4x a laptop's for these workloads,
 * so the demo win is real.
 *
 * Docs consulted (fetched 2026-07-10):
 *   https://docs.qvac.tether.io/p2p-capabilities/delegated-inference/
 *   https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
 *   https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html
 *
 * SDK API (per docs):
 *   const sdk = createQVACSdk({...})
 *   const provider = await sdk.startQVACProvider({
 *     firewall: { mode: 'allow', publicKeys: [...] }
 *   })
 *   provider.publicKey  // hex string peers put in their registry
 *   provider.close()
 *
 * Boot behaviour:
 *   - ENABLE_QVAC_PROVIDER=false (default) → module returns null status,
 *     never touches @qvac/sdk. `GET /qvac/provider` reports 'disabled'.
 *   - ENABLE_QVAC_PROVIDER=true + @qvac/sdk not installed → status becomes
 *     'unavailable' with reason:'sdk-missing'. `GET /qvac/provider` responds
 *     with 200 + that shape so operators can diagnose.
 *   - ENABLE_QVAC_PROVIDER=true + SDK installed → provider spins up on the
 *     first getDelegatedProvider() call (lazy — avoids blocking Fastify boot
 *     on QVAC's async initialisation).
 *
 * Firewall posture:
 *   - Default mode 'allow' requires QVAC_ALLOWED_PUBKEYS to be non-empty.
 *     Empty allow-list + mode:'allow' → refuse to start (fail-closed).
 *   - Mode 'allow-all' permits every peer. Warns loudly at boot.
 */

import {
  ENABLE_QVAC_PROVIDER,
  QVAC_ALLOWED_PUBKEYS,
  QVAC_FIREWALL_MODE,
  QVAC_PROVIDER_MODELS,
} from '../../config/main-config.ts';
import { getModel } from './registry.ts';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type DelegatedProviderStatus =
  | 'disabled'
  | 'unavailable'
  | 'starting'
  | 'running'
  | 'failed';

export interface DelegatedProviderReport {
  status: DelegatedProviderStatus;
  publicKey: string | null;
  reason: string | null;
  firewall: {
    mode: 'allow' | 'allow-all';
    allowedPubkeyCount: number;
  };
  models: Array<{ id: string; family: string; loaded: boolean }>;
  startedAt: string | null;
}

interface ProviderHandle {
  publicKey: string;
  close(): Promise<void>;
}

interface QvacSdkFacade {
  startQVACProvider(opts: {
    firewall: { mode: string; publicKeys?: string[] };
  }): Promise<ProviderHandle>;
}

// -----------------------------------------------------------------------------
// SDK lazy load
//
// We wrap the import so a missing @qvac/sdk on the backend host does not
// crash boot; instead the provider reports 'unavailable' with a diagnostic
// reason. This is critical because the backend Dockerfile in
// `backend/Dockerfile` today does not `bun add @qvac/sdk` — that install is
// a Wave 3 follow-up per SUBMISSION.md.
// -----------------------------------------------------------------------------

const loadSdk = async (): Promise<QvacSdkFacade | null> => {
  try {
    // Use dynamic import so tests can shadow the module resolution.
    // @ts-ignore — @qvac/sdk is an optional runtime dep, may be absent.
    const mod = await import('@qvac/sdk');
    // The SDK docs describe both `createQVACSdk()` and a default export. We
    // support both shapes because the docs are ahead of the shipping package
    // in some snapshots.
    if (typeof (mod as { createQVACSdk?: unknown }).createQVACSdk === 'function') {
      const sdk = (mod as { createQVACSdk: () => QvacSdkFacade }).createQVACSdk();
      return sdk;
    }
    if (typeof (mod as { default?: { startQVACProvider?: unknown } }).default?.startQVACProvider === 'function') {
      return (mod as { default: QvacSdkFacade }).default;
    }
    if (typeof (mod as { startQVACProvider?: unknown }).startQVACProvider === 'function') {
      return mod as unknown as QvacSdkFacade;
    }
    return null;
  } catch {
    return null;
  }
};

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

interface ProviderState {
  status: DelegatedProviderStatus;
  handle: ProviderHandle | null;
  publicKey: string | null;
  reason: string | null;
  startedAt: string | null;
  models: Array<{ id: string; family: string; loaded: boolean }>;
}

let _state: ProviderState = {
  status: 'disabled',
  handle: null,
  publicKey: null,
  reason: null,
  startedAt: null,
  models: [],
};

let _startPromise: Promise<ProviderState> | null = null;

const HEX64 = /^[0-9a-f]{64}$/;

const validateAllowList = (
  keys: string[]
): { ok: true; keys: string[] } | { ok: false; reason: string } => {
  const cleaned = keys.map((k) => k.toLowerCase());
  for (const k of cleaned) {
    if (!HEX64.test(k)) {
      return {
        ok: false,
        reason: `QVAC_ALLOWED_PUBKEYS contains invalid entry: ${k.slice(0, 8)}... (expected 32-byte hex)`,
      };
    }
  }
  return { ok: true, keys: cleaned };
};

const resolveModels = (): Array<{ id: string; family: string; loaded: boolean }> => {
  const out: Array<{ id: string; family: string; loaded: boolean }> = [];
  for (const id of QVAC_PROVIDER_MODELS) {
    const m = getModel(id);
    if (!m) {
      console.warn(
        `[qvac-provider] configured model "${id}" not in registry; ignored`
      );
      continue;
    }
    out.push({ id: m.id, family: m.family, loaded: false });
  }
  return out;
};

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Lazy start. Returns the current state after best-effort initialisation.
 * Idempotent — concurrent callers share the same in-flight startup promise.
 * Never throws; failure surfaces via `state.status === 'failed'`.
 */
export const getDelegatedProvider = async (): Promise<DelegatedProviderReport> => {
  if (!ENABLE_QVAC_PROVIDER) {
    return snapshot('disabled', null);
  }
  if (_state.status === 'running' || _state.status === 'failed' || _state.status === 'unavailable') {
    return snapshot(_state.status, _state.reason);
  }
  if (_startPromise) {
    await _startPromise;
    return snapshot(_state.status, _state.reason);
  }
  _startPromise = (async () => {
    _state.status = 'starting';
    // 1. Firewall validation. Fail-closed if allow-list is empty in 'allow' mode.
    if (QVAC_FIREWALL_MODE === 'allow' && QVAC_ALLOWED_PUBKEYS.length === 0) {
      _state.status = 'failed';
      _state.reason = 'firewall-allow-list-empty (set QVAC_ALLOWED_PUBKEYS or use QVAC_FIREWALL_MODE=allow-all)';
      console.error('[qvac-provider] refusing to start:', _state.reason);
      return _state;
    }
    const check = validateAllowList(QVAC_ALLOWED_PUBKEYS);
    if (!check.ok && QVAC_FIREWALL_MODE === 'allow') {
      _state.status = 'failed';
      _state.reason = check.reason;
      console.error('[qvac-provider] refusing to start:', _state.reason);
      return _state;
    }
    if (QVAC_FIREWALL_MODE === 'allow-all') {
      console.warn(
        '[qvac-provider] firewall mode allow-all: provider open to all peers'
      );
    }
    // 2. Model resolution against the static registry.
    _state.models = resolveModels();
    if (_state.models.length === 0) {
      _state.status = 'failed';
      _state.reason = 'no valid models in QVAC_PROVIDER_MODELS';
      console.error('[qvac-provider]', _state.reason);
      return _state;
    }
    // 3. Load SDK. If missing, report 'unavailable' and stop — this is the
    // path a fresh backend deploy takes before @qvac/sdk is installed.
    const sdk = await loadSdk();
    if (!sdk) {
      _state.status = 'unavailable';
      _state.reason =
        '@qvac/sdk not installed on backend host; provider disabled';
      console.warn('[qvac-provider]', _state.reason);
      return _state;
    }
    // 4. Start provider.
    try {
      const handle = await sdk.startQVACProvider({
        firewall: {
          mode: QVAC_FIREWALL_MODE,
          publicKeys: check.ok ? check.keys : undefined,
        },
      });
      if (!handle || typeof handle.publicKey !== 'string') {
        _state.status = 'failed';
        _state.reason = 'sdk returned handle without publicKey';
        return _state;
      }
      _state.handle = handle;
      _state.publicKey = handle.publicKey;
      _state.startedAt = new Date().toISOString();
      _state.status = 'running';
      _state.reason = null;
      _state.models = _state.models.map((m) => ({ ...m, loaded: true }));
      console.log(
        `[qvac-provider] started; publicKey=${handle.publicKey.slice(0, 16)}... models=${_state.models.length}`
      );
      return _state;
    } catch (err) {
      _state.status = 'failed';
      _state.reason = `sdk.startQVACProvider threw: ${(err as Error)?.message || 'unknown'}`;
      console.error('[qvac-provider]', _state.reason);
      return _state;
    }
  })();
  await _startPromise;
  _startPromise = null;
  return snapshot(_state.status, _state.reason);
};

/**
 * Synchronous read of the current state. Does NOT trigger lazy start; useful
 * for the metrics endpoint or health checks that must not block.
 */
export const getDelegatedProviderStateSnapshot = (): DelegatedProviderReport => {
  if (!ENABLE_QVAC_PROVIDER) return snapshot('disabled', null);
  return snapshot(_state.status, _state.reason);
};

/**
 * Graceful shutdown. Called from the SIGTERM handler in index.ts so the SDK
 * gets a chance to close its socket before the process exits.
 */
export const stopDelegatedProvider = async (): Promise<void> => {
  const handle = _state.handle;
  _state.handle = null;
  _state.status = 'disabled';
  _state.publicKey = null;
  if (handle) {
    try { await handle.close(); } catch { /* noop */ }
  }
};

const snapshot = (
  status: DelegatedProviderStatus,
  reason: string | null
): DelegatedProviderReport => ({
  status,
  publicKey: status === 'running' ? _state.publicKey : null,
  reason,
  firewall: {
    mode: QVAC_FIREWALL_MODE,
    allowedPubkeyCount: QVAC_ALLOWED_PUBKEYS.length,
  },
  models: [..._state.models],
  startedAt: status === 'running' ? _state.startedAt : null,
});

// Test-only reset.
export const __resetForTest = (): void => {
  _state = {
    status: 'disabled',
    handle: null,
    publicKey: null,
    reason: null,
    startedAt: null,
    models: [],
  };
  _startPromise = null;
};
