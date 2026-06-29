/**
 * F10 multi-chain loader (ARCHITECTURE.md Section 20 + ADR-009).
 *
 * Source of truth: `src/data/chains.json` (committed). Per-chain env overrides:
 *
 *   CHAIN_<chainId>_RPC_URLS           comma-separated, replaces JSON rpcUrls
 *   CHAIN_<chainId>_USDT               0x..., replaces JSON usdtAddress
 *   CHAIN_<chainId>_ENABLED            'true'/'false', replaces JSON enabled
 *   CHAIN_<chainId>_START_BLOCK        integer, replaces bootstrapBackfillBlocks bootstrap anchor
 *   CHAIN_<chainId>_SCAN_RANGE_BLOCKS  integer, replaces maxBlockSpan
 *   CHAIN_<chainId>_BLOCK_CONFIRMATIONS integer, replaces blockConfirmations
 *
 * Backwards-compat: if `CHAIN_11155111_RPC_URLS` is unset, we fall back to the
 * legacy `SEPOLIA_RPC_URLS` env. Same for `SEPOLIA_USDT_ADDRESS`. One-release
 * deprecation window per ADR-009.
 *
 * WHY THIS FILE READS process.env DIRECTLY (the one place we bypass
 * main-config.ts): chain IDs are dynamic — every entry in chains.json brings
 * its own env knobs (CHAIN_<chainId>_*). Hard-coding each in main-config.ts
 * would defeat the purpose of a config-driven loader. Reads happen once at
 * module init and the result is frozen, so the boundary discipline (no scattered
 * process.env reads at request time) is preserved.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ChainConfig {
  chainId: number;
  name: string;
  shortName: string;
  isTestnet: boolean;
  isDefault: boolean;
  enabled: boolean;
  rpcUrls: string[];
  usdtAddress: string; // lowercase; '' means "not deployed yet"
  tokenDecimals: number;
  blockConfirmations: number;
  bootstrapBackfillBlocks: number;
  maxBlockSpan: number;
  explorerBase: string;
  notes: string | null;
}

interface ChainsFile {
  chains: Array<Partial<ChainConfig> & Pick<ChainConfig, 'chainId' | 'name'>>;
}

export const DEFAULT_CHAIN_ID = 11155111; // Sepolia per ADR-009

// =============================================================================
// One-time load + freeze at module init.
// =============================================================================

const CHAINS_JSON_PATH = resolve(process.cwd(), 'src/data/chains.json');

const parseBool = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined;
  const norm = raw.trim().toLowerCase();
  if (norm === 'true' || norm === '1' || norm === 'yes') return true;
  if (norm === 'false' || norm === '0' || norm === 'no') return false;
  return undefined;
};

const parseInteger = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  return n;
};

const parseList = (raw: string | undefined): string[] | undefined => {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
};

const loadJsonChains = (): ChainsFile => {
  let txt: string;
  try {
    txt = readFileSync(CHAINS_JSON_PATH, 'utf8');
  } catch (err) {
    throw new Error(
      `[chains] failed to read ${CHAINS_JSON_PATH}: ${(err as Error)?.message ?? String(err)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch (err) {
    throw new Error(`[chains] ${CHAINS_JSON_PATH} is not valid JSON: ${(err as Error)?.message}`);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { chains?: unknown }).chains)
  ) {
    throw new Error(`[chains] ${CHAINS_JSON_PATH} must contain a top-level 'chains' array`);
  }
  return parsed as ChainsFile;
};

const overlayEnv = (base: ChainConfig): ChainConfig => {
  const id = base.chainId;
  // Per-chain env keys (dynamic chainId; cannot live in main-config.ts).
  const envRpcs = parseList(process.env[`CHAIN_${id}_RPC_URLS`]);
  const envUsdt = process.env[`CHAIN_${id}_USDT`];
  const envEnabled = parseBool(process.env[`CHAIN_${id}_ENABLED`]);
  const envStartBlock = parseInteger(process.env[`CHAIN_${id}_START_BLOCK`]);
  const envScanRange = parseInteger(process.env[`CHAIN_${id}_SCAN_RANGE_BLOCKS`]);
  const envConfirmations = parseInteger(process.env[`CHAIN_${id}_BLOCK_CONFIRMATIONS`]);

  // Backwards-compat shims for Sepolia (one-release deprecation, per ADR-009).
  let rpcUrls = envRpcs ?? base.rpcUrls;
  let usdtAddress = (envUsdt ?? base.usdtAddress).trim().toLowerCase();
  if (id === DEFAULT_CHAIN_ID) {
    if (!envRpcs && process.env.SEPOLIA_RPC_URLS) {
      const legacy = parseList(process.env.SEPOLIA_RPC_URLS);
      if (legacy) rpcUrls = legacy;
    }
    if (!envUsdt && process.env.SEPOLIA_USDT_ADDRESS) {
      usdtAddress = process.env.SEPOLIA_USDT_ADDRESS.trim().toLowerCase();
    }
  }

  return {
    ...base,
    rpcUrls,
    usdtAddress,
    enabled: envEnabled ?? base.enabled,
    bootstrapBackfillBlocks: envStartBlock ?? base.bootstrapBackfillBlocks,
    maxBlockSpan: envScanRange ?? base.maxBlockSpan,
    blockConfirmations: envConfirmations ?? base.blockConfirmations,
  };
};

const normalizeFromJson = (raw: ChainsFile['chains'][number]): ChainConfig => ({
  chainId: raw.chainId,
  name: raw.name,
  shortName: raw.shortName ?? String(raw.chainId),
  isTestnet: raw.isTestnet ?? false,
  isDefault: raw.isDefault ?? false,
  enabled: raw.enabled ?? false,
  rpcUrls: Array.isArray(raw.rpcUrls) ? raw.rpcUrls.filter(Boolean) : [],
  usdtAddress: (raw.usdtAddress ?? '').toLowerCase(),
  tokenDecimals: raw.tokenDecimals ?? 6,
  blockConfirmations: raw.blockConfirmations ?? 5,
  bootstrapBackfillBlocks: raw.bootstrapBackfillBlocks ?? 1000,
  maxBlockSpan: raw.maxBlockSpan ?? 2000,
  explorerBase: raw.explorerBase ?? '',
  notes: raw.notes ?? null,
});

let CONFIGURED: ReadonlyArray<ChainConfig> | null = null;
const incompleteWarned = new Set<number>();

const buildConfigured = (): ReadonlyArray<ChainConfig> => {
  const file = loadJsonChains();
  const seen = new Set<number>();
  const out: ChainConfig[] = [];
  for (const raw of file.chains) {
    if (typeof raw.chainId !== 'number' || !Number.isInteger(raw.chainId)) {
      throw new Error(`[chains] each entry must have a numeric chainId; got ${String(raw.chainId)}`);
    }
    if (seen.has(raw.chainId)) {
      throw new Error(`[chains] duplicate chainId ${raw.chainId} in chains.json`);
    }
    seen.add(raw.chainId);
    out.push(Object.freeze(overlayEnv(normalizeFromJson(raw))));
  }
  if (out.length === 0) {
    throw new Error(`[chains] chains.json must contain at least one chain entry`);
  }
  return Object.freeze(out);
};

const getConfigured = (): ReadonlyArray<ChainConfig> => {
  if (CONFIGURED === null) {
    CONFIGURED = buildConfigured();
  }
  return CONFIGURED;
};

// =============================================================================
// Public API
// =============================================================================

export const getAllConfiguredChains = (): ChainConfig[] => [...getConfigured()];

export const getEnabledChains = (): ChainConfig[] => {
  const all = getConfigured();
  const enabled: ChainConfig[] = [];
  for (const c of all) {
    if (!c.enabled) continue;
    if (c.usdtAddress.length === 0) {
      // Loud-once warning so ops sees the misconfiguration in logs.
      if (!incompleteWarned.has(c.chainId)) {
        console.warn(
          `[chains] Chain ${c.chainId} (${c.name}) is enabled but has no USDT address; skipping. Set CHAIN_${c.chainId}_USDT to fix.`
        );
        incompleteWarned.add(c.chainId);
      }
      continue;
    }
    if (c.rpcUrls.length === 0) {
      if (!incompleteWarned.has(c.chainId)) {
        console.warn(
          `[chains] Chain ${c.chainId} (${c.name}) is enabled but has no RPC URLs; skipping. Set CHAIN_${c.chainId}_RPC_URLS to fix.`
        );
        incompleteWarned.add(c.chainId);
      }
      continue;
    }
    enabled.push(c);
  }
  return enabled;
};

export const getChain = (chainId: number): ChainConfig | undefined => {
  return getConfigured().find((c) => c.chainId === chainId);
};

export const getDefaultChain = (): ChainConfig => {
  const all = getConfigured();
  const flagged = all.find((c) => c.isDefault);
  if (flagged) return flagged;
  const byId = all.find((c) => c.chainId === DEFAULT_CHAIN_ID);
  if (byId) return byId;
  const fallback = all[0];
  if (!fallback) throw new Error('[chains] no chains configured');
  return fallback;
};

/**
 * Test-only: drop the cached configuration so a test can re-load chains.json
 * after mutating process.env. NEVER call from production code.
 */
export const __resetForTest = (): void => {
  CONFIGURED = null;
  incompleteWarned.clear();
};
