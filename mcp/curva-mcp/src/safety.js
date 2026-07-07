// Per-session spend tracker and prompt-injection guard.
//
// Docs verified:
//   - https://docs.wdk.tether.io/ai/agent-skills/ requires per-session ceilings
//     for value-transfer capabilities and reserves final enforcement for the
//     host runtime. This module is the process-scoped fallback for hosts that
//     do not implement a session ledger.
//   - SKILL.md capability limits (send_tip: 5 USDT default, session 25 USDT;
//     pay_x402_resource: 1 USDT per call, 5 USDT per session).

import { CONFIG } from './config.js';

// Session ledger. Keyed by capability so a tip cap does not swallow x402 head-
// room and vice versa. Values are decimal USDT (not atomic base units).
const spent = {
  tip: 0,
  stake: 0,
  x402: 0,
};

function ensureNonNegative(amount, label) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new RangeError(`${label} must be non-negative finite number`);
  }
}

export const sessionSpend = {
  // Tip cap (send_tip). Per-call red-flag surfaced separately.
  tipRemaining: () => Math.max(0, CONFIG.sessionTipCapUsdt - spent.tip),
  tipWouldExceed: (amount) => {
    ensureNonNegative(amount, 'amount');
    if (amount > CONFIG.perCallTipCapUsdt) return true;
    return spent.tip + amount > CONFIG.sessionTipCapUsdt;
  },
  tipRecord: (amount) => {
    ensureNonNegative(amount, 'amount');
    spent.tip += amount;
  },

  // Prediction stake cap (submit_prediction).
  stakeRemaining: () => Math.max(0, CONFIG.sessionStakeCapUsdt - spent.stake),
  stakeWouldExceed: (amount) => {
    ensureNonNegative(amount, 'amount');
    return spent.stake + amount > CONFIG.sessionStakeCapUsdt;
  },
  stakeRecord: (amount) => {
    ensureNonNegative(amount, 'amount');
    spent.stake += amount;
  },

  // x402 per-call ceiling (pay_x402_resource).
  x402PerCallCap: () => CONFIG.perCallX402CapUsdt,
  x402Record: (amount) => {
    ensureNonNegative(amount, 'amount');
    spent.x402 += amount;
  },

  // Diagnostics for tool responses.
  snapshot: () => ({
    tipSpent: spent.tip,
    stakeSpent: spent.stake,
    x402Spent: spent.x402,
    tipCap: CONFIG.sessionTipCapUsdt,
    stakeCap: CONFIG.sessionStakeCapUsdt,
  }),

  // Test hook. NOT exposed on the MCP surface. Never called at runtime.
  __resetForTest: () => {
    spent.tip = 0;
    spent.stake = 0;
    spent.x402 = 0;
  },
};

// -----------------------------------------------------------------------------
// Prompt-injection guard
// -----------------------------------------------------------------------------
// Rejects tool inputs that look like they were smuggled from untrusted chat and
// try to escalate the agent runtime. Applied to every tool's arguments before
// signing or HTTP call. False positives are preferable to a signed authorization
// with a manipulated `note` field ending up in a settlement receipt.
//
// Source: https://docs.wdk.tether.io/ai/agent-skills/ ("prompt injection
// detection rules"). SKILL.md line 180 reinforces this.
const INJECTION_PATTERNS = [
  /ignore\s+(all|previous|prior)\s+instructions/i,
  /disregard\s+(all|previous|prior)\s+instructions/i,
  /system\s*[:>]\s*/i,
  /\bexec(ute)?\b[^\n]{0,40}\bshell\b/i,
  /<\|.*?\|>/,
  /\bBEGIN\s+PROMPT\b/i,
  /\bYou are (now|actually|really) a\b/i,
];

export function assertClean(input) {
  let s;
  try {
    s = JSON.stringify(input ?? {});
  } catch {
    throw new Error('PROMPT_INJECTION_BLOCKED: unserializable input');
  }
  if (s.length > 8192) {
    throw new Error('PROMPT_INJECTION_BLOCKED: input too large');
  }
  for (const re of INJECTION_PATTERNS) {
    if (re.test(s)) {
      throw new Error('PROMPT_INJECTION_BLOCKED');
    }
  }
}

// Structured log line for stderr. stdio MCP servers MUST NOT write to stdout
// (it is the transport). All observability goes to stderr as one JSON per line
// so downstream log shippers can parse it.
export function logJson(level, event, extra = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...extra,
  });
  // eslint-disable-next-line no-console
  console.error(line);
}
