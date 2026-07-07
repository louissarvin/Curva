// Curva MCP configuration. All values come from environment; sensible defaults
// mirror pear-app/bare/wallet/eip3009.js SEPOLIA constant so the F11 facilitator
// on the Curva Companion accepts our signatures without shape drift.
//
// Docs verified:
//   - Sepolia bundler URL format: https://api.candide.dev/public/v3/<chainId>
//     https://docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/configuration/
//   - onChainIdentifier accepts string form ('curva') or object form; string is
//     what pear-app/bare/wallet/eip3009.js ships and the F11 facilitator strips
//     it before recovering the EOA.
//   - Token name/version match the on-chain USDT deployment probe used by
//     backend/src/lib/evm/eip3009.ts. If USDT gets redeployed with different
//     domain fields, set CURVA_TOKEN_NAME / CURVA_TOKEN_VERSION to override.

function required(name) {
  const val = process.env[name];
  if (!val || val.length === 0) {
    throw new Error(`CONFIG_MISSING: ${name} env var is required`);
  }
  return val;
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`CONFIG_INVALID: ${name} must be a number`);
  return n;
}

export const CONFIG = Object.freeze({
  // Curva Companion (Fastify on Bun). Default matches backend/index.ts APP_PORT.
  backendBaseUrl: process.env.CURVA_MCP_BACKEND_URL || 'http://localhost:3700',

  // Chain wiring. Sepolia is the demo chain. Change all four together.
  chainId: num('CURVA_MCP_CHAIN_ID', 11155111),
  provider:
    process.env.CURVA_MCP_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
  bundlerUrl:
    process.env.CURVA_MCP_BUNDLER_URL ||
    'https://api.candide.dev/public/v3/11155111',
  paymasterUrl:
    process.env.CURVA_MCP_PAYMASTER_URL ||
    'https://api.candide.dev/public/v3/11155111',
  paymasterAddress:
    (process.env.CURVA_MCP_PAYMASTER_ADDRESS ||
      '0x8b1f6cb5d062aa2ce8d581942bbb960420d875ba').toLowerCase(),

  // USDT on Sepolia. Same address as pear-app SEPOLIA constant.
  usdtAddress: (
    process.env.CURVA_MCP_USDT_ADDRESS ||
    '0xd077a400968890eacc75cdc901f0356c943e4fdb'
  ).toLowerCase(),
  tokenName: process.env.CURVA_MCP_TOKEN_NAME || 'USDT',
  tokenVersion: process.env.CURVA_MCP_TOKEN_VERSION || '1',

  // WDK marker so all UserOperations (fallback path) carry a "curva" tag.
  onChainIdentifier: process.env.CURVA_MCP_ON_CHAIN_ID || 'curva',

  // Wallet secret. BIP-39 mnemonic. NEVER logged. Fail fast if absent.
  get seed() {
    return required('CURVA_MCP_WALLET_SEED');
  },

  // Per-session and per-call spend ceilings in USDT (decimal, not atomic).
  // Belt-and-braces layer per WDK agent-skill guidance
  // (https://docs.wdk.tether.io/ai/agent-skills/ says the host runtime SHOULD
  // enforce these; we enforce here too because stdio hosts often do not).
  sessionTipCapUsdt: num('CURVA_MCP_SESSION_TIP_CAP_USDT', 25),
  perCallTipCapUsdt: num('CURVA_MCP_PER_CALL_TIP_CAP_USDT', 15),
  sessionStakeCapUsdt: num('CURVA_MCP_SESSION_STAKE_CAP_USDT', 10),
  perCallX402CapUsdt: num('CURVA_MCP_PER_CALL_X402_CAP_USDT', 1),

  // Red-flag threshold: prompts an extra "you are spending a lot" line in the
  // elicitation dialog when a single tip exceeds this.
  redFlagUsdt: num('CURVA_MCP_RED_FLAG_USDT', 10),
});

// Fixed atomic unit count for USDT. USDT is 6 decimals on every chain we ship.
export const USDT_DECIMALS = 6;

// Convert decimal USDT (e.g. 3.5) to atomic string (e.g. "3500000"). Uses
// BigInt to avoid float truncation on amounts > 2^53 base units.
export function usdtToAtomic(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new RangeError('amount must be non-negative finite number');
  }
  // Multiply by 10^6 with rounding so 0.1 -> 100000 exactly.
  return String(BigInt(Math.round(amount * 1_000_000)));
}
