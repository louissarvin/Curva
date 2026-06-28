/**
 * Centralized configuration for the Curva Companion backend.
 * All environment variable access in the codebase goes through this file.
 * Do NOT use process.env.X outside of this module.
 */

// Validate required environment variables on startup
const requiredEnvVars: string[] = [
  'DATABASE_URL',
  'JWT_SECRET',
  'SEPOLIA_RPC_URLS',
  'SEEDER_NOISE_SEED',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`FATAL: Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// App Configuration
export const APP_PORT: number = Number(process.env.APP_PORT) || 3700;
export const NODE_ENV: string = process.env.NODE_ENV || 'development';
export const IS_DEV: boolean = NODE_ENV === 'development';
export const IS_PROD: boolean = NODE_ENV === 'production';

// Database
export const DATABASE_URL: string = process.env.DATABASE_URL as string;

// Authentication (kept for compatibility with starter authMiddleware; unused by Curva)
export const JWT_SECRET: string = process.env.JWT_SECRET as string;
export const JWT_EXPIRES_IN: string = process.env.JWT_EXPIRES_IN || '7d';

// Error log
export const ERROR_LOG_MAX_RECORDS: number = 10000;
export const ERROR_LOG_CLEANUP_INTERVAL: string = '0 * * * *'; // Every hour

// CORS allowlist (comma-separated). Pear deeplinks use `pear://`.
export const CORS_ORIGINS: string[] = (process.env.CORS_ORIGINS ||
  'pear://curva,https://curva.app,http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const LANDING_ORIGIN: string | undefined = process.env.LANDING_ORIGIN;

// Request body limit (Curva endpoints accept tiny JSON payloads)
export const BODY_LIMIT_BYTES: number = Number(process.env.BODY_LIMIT_BYTES) || 1024 * 1024; // 1 MB

// Number of proxy hops Fastify should trust when resolving request.ip from
// X-Forwarded-For. Defaults to 1 (single edge proxy in front of the app, e.g.
// Fly.io / Railway). Setting this to a boolean true is unsafe because it trusts
// every IP an attacker injects into the header; numeric hop count is the
// OWASP-recommended pattern. See SECURITY_AUDIT.md HIGH-01.
export const TRUST_PROXY_HOPS: number = Number(process.env.TRUST_PROXY_HOPS) || 1;

// =============================================================================
// EVM / Tip indexer
// =============================================================================

export const SEPOLIA_RPC_URLS: string[] = (process.env.SEPOLIA_RPC_URLS as string)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const SEPOLIA_CHAIN_ID: number = 11155111;
export const SEPOLIA_USDT_ADDRESS: string = (
  process.env.SEPOLIA_USDT_ADDRESS || '0xd077a400968890eacc75cdc901f0356c943e4fdb'
).toLowerCase();
export const USDT_DECIMALS: number = 6;
export const TIP_INDEXER_INTERVAL_CRON: string =
  process.env.TIP_INDEXER_INTERVAL_CRON || '*/15 * * * * *';
export const TIP_INDEXER_CONFIRMATIONS: number =
  Number(process.env.TIP_INDEXER_CONFIRMATIONS) || 5;
export const TIP_INDEXER_MAX_BLOCK_SPAN: number =
  Number(process.env.TIP_INDEXER_MAX_BLOCK_SPAN) || 2000;
export const TIP_INDEXER_BOOTSTRAP_BACKFILL: number =
  Number(process.env.TIP_INDEXER_BOOTSTRAP_BACKFILL) || 1000;

// =============================================================================
// Pears seeder
// =============================================================================

export const ENABLE_SEEDER: boolean = (process.env.ENABLE_SEEDER || 'false').toLowerCase() === 'true';
export const SEEDER_NOISE_SEED: string = process.env.SEEDER_NOISE_SEED as string;
// Per ADR-002: 256MB Fly.io VM can host ~5 subprocesses (~30-40 MB RSS each).
// Higher caps risk OOM-killing the API process. Override via env if running on
// a larger VM. See SECURITY_AUDIT.md HIGH-02.
export const SEEDER_MAX_ROOMS: number = Number(process.env.SEEDER_MAX_ROOMS) || 5;
export const SEEDER_BARE_ENTRY: string =
  process.env.SEEDER_BARE_ENTRY || './seeder/bareSeeder.mjs';
export const SEEDER_REGION: string = process.env.SEEDER_REGION || 'us-east';
export const SEEDER_RECONCILE_CRON: string = process.env.SEEDER_RECONCILE_CRON || '* * * * *';

// =============================================================================
// Catalog sync
// =============================================================================

export const FOOTBALL_DATA_API_KEY: string | undefined = process.env.FOOTBALL_DATA_API_KEY;
export const FOOTBALL_DATA_COMPETITION: string = process.env.FOOTBALL_DATA_COMPETITION || 'WC';
export const CATALOG_SYNC_CRON: string = process.env.CATALOG_SYNC_CRON || '0 */6 * * *';

// =============================================================================
// Room directory
// =============================================================================

export const ROOM_RATE_LIMIT_MAX: number = Number(process.env.ROOM_RATE_LIMIT_MAX) || 5;
export const ROOM_RATE_LIMIT_WINDOW: string = process.env.ROOM_RATE_LIMIT_WINDOW || '1 minute';
export const ROOM_DELETE_RATE_LIMIT_MAX: number =
  Number(process.env.ROOM_DELETE_RATE_LIMIT_MAX) || 10;
export const ROOM_DELETE_RATE_LIMIT_WINDOW: string =
  process.env.ROOM_DELETE_RATE_LIMIT_WINDOW || '5 minutes';
// Per-IP throttle on the unauthenticated GET /rooms/:slug/delete-challenge.
// Keeps challenge-store memory bounded against probing while still letting a
// legit host retry a handful of times. See SECURITY_AUDIT.md CRIT-01a.
export const ROOM_DELETE_CHALLENGE_RATE_LIMIT_MAX: number =
  Number(process.env.ROOM_DELETE_CHALLENGE_RATE_LIMIT_MAX) || 3;
export const ROOM_DELETE_CHALLENGE_RATE_LIMIT_WINDOW: string =
  process.env.ROOM_DELETE_CHALLENGE_RATE_LIMIT_WINDOW || '1 minute';
export const ROOM_POST_MATCH_BUFFER_HOURS: number =
  Number(process.env.ROOM_POST_MATCH_BUFFER_HOURS) || 24;
export const ROOM_MATCH_DURATION_HOURS: number =
  Number(process.env.ROOM_MATCH_DURATION_HOURS) || 4;
export const ROOM_CLEANUP_CRON: string = process.env.ROOM_CLEANUP_CRON || '*/10 * * * *';
export const ROOM_CHALLENGE_TTL_SECONDS: number =
  Number(process.env.ROOM_CHALLENGE_TTL_SECONDS) || 300;

// =============================================================================
// Service metadata
// =============================================================================

export const SERVICE_VERSION: string = process.env.SERVICE_VERSION || '0.1.0';
export const SERVICE_STARTED_AT: number = Date.now();

// =============================================================================
// Section 19 (Phase 2 maximization features)
// =============================================================================

// F1: Activity feed (SSE)
export const SSE_MAX_CONNECTIONS: number = Number(process.env.SSE_MAX_CONNECTIONS) || 1000;
// Wave 3 bumped the default ring-buffer size from 500 to 1000 so that Last-Event-ID
// replays survive a chatty live-match tick (F7 publishes up to 5 events per minute
// per active fixture). Memory ceiling stays modest: ~1KB/event * 1000 = ~1MB.
export const SSE_BUFFER_SIZE: number = Number(process.env.SSE_BUFFER_SIZE) || 1000;
// Per-IP cap on concurrent SSE connections. SSE streams are long-lived, so a
// per-minute rate limit cannot evict an existing connection; we track the live
// set and reject the (N+1)th from the same IP. See SECURITY_AUDIT.md W2-HIGH-02.
export const SSE_MAX_CONNECTIONS_PER_IP: number =
  Number(process.env.SSE_MAX_CONNECTIONS_PER_IP) || 5;
// Rate limit on the JSON history endpoint (the stream is connection-capped).
export const ACTIVITY_HISTORY_RATE_LIMIT_MAX: number =
  Number(process.env.ACTIVITY_HISTORY_RATE_LIMIT_MAX) || 30;
export const ACTIVITY_HISTORY_RATE_LIMIT_WINDOW: string =
  process.env.ACTIVITY_HISTORY_RATE_LIMIT_WINDOW || '1 minute';

// F2: Auto-warm scheduler
// If either address is unset the worker no-ops and logs a single warning at
// boot. The worker never crashes the process on missing env.
export const AUTO_WARM_HOST_OWNER_ADDRESS: string | undefined =
  process.env.AUTO_WARM_HOST_OWNER_ADDRESS?.toLowerCase();
export const AUTO_WARM_HOST_SMART_ADDRESS: string | undefined =
  process.env.AUTO_WARM_HOST_SMART_ADDRESS?.toLowerCase();
export const MATCH_AUTO_WARM_CRON: string = process.env.MATCH_AUTO_WARM_CRON || '*/5 * * * *';
export const MATCH_AUTO_WARM_LEAD_MINUTES: number =
  Number(process.env.MATCH_AUTO_WARM_LEAD_MINUTES) || 30;

// F3: Leaderboard
export const LEADERBOARD_RATE_LIMIT_MAX: number =
  Number(process.env.LEADERBOARD_RATE_LIMIT_MAX) || 60;
export const LEADERBOARD_RATE_LIMIT_WINDOW: string =
  process.env.LEADERBOARD_RATE_LIMIT_WINDOW || '1 minute';
export const LEADERBOARD_CACHE_TTL_MS: number =
  Number(process.env.LEADERBOARD_CACHE_TTL_MS) || 60_000;

// Public /health + /health/db rate limit (SECURITY_AUDIT MED-04). The endpoint
// stays unauthenticated so judges can smoke-test the deploy, but per-route
// throttling caps scraping attempts.
export const HEALTH_RATE_LIMIT_MAX: number = Number(process.env.HEALTH_RATE_LIMIT_MAX) || 30;
export const HEALTH_RATE_LIMIT_WINDOW: string =
  process.env.HEALTH_RATE_LIMIT_WINDOW || '1 minute';

// F4: Status page
export const STATUS_RATE_LIMIT_MAX: number = Number(process.env.STATUS_RATE_LIMIT_MAX) || 30;
export const STATUS_RATE_LIMIT_WINDOW: string =
  process.env.STATUS_RATE_LIMIT_WINDOW || '1 minute';
export const STATUS_CACHE_TTL_MS: number = Number(process.env.STATUS_CACHE_TTL_MS) || 5_000;

// F5: Demo seed (bearer-token gated; route returns 404 when token unset per ADR-007)
export const DEMO_SEED_TOKEN: string | undefined = process.env.DEMO_SEED_TOKEN;
export const DEMO_SEED_RATE_LIMIT_MAX: number =
  Number(process.env.DEMO_SEED_RATE_LIMIT_MAX) || 5;
export const DEMO_SEED_RATE_LIMIT_WINDOW: string =
  process.env.DEMO_SEED_RATE_LIMIT_WINDOW || '1 minute';
export const DEMO_WALLET_SUD_OWNER: string | undefined =
  process.env.DEMO_WALLET_SUD_OWNER?.toLowerCase();
export const DEMO_WALLET_SUD_SMART: string | undefined =
  process.env.DEMO_WALLET_SUD_SMART?.toLowerCase();
export const DEMO_WALLET_NORD_OWNER: string | undefined =
  process.env.DEMO_WALLET_NORD_OWNER?.toLowerCase();
export const DEMO_WALLET_NORD_SMART: string | undefined =
  process.env.DEMO_WALLET_NORD_SMART?.toLowerCase();

// F6: Phrasebook
export const PHRASEBOOK_RATE_LIMIT_MAX: number =
  Number(process.env.PHRASEBOOK_RATE_LIMIT_MAX) || 30;
export const PHRASEBOOK_RATE_LIMIT_WINDOW: string =
  process.env.PHRASEBOOK_RATE_LIMIT_WINDOW || '1 minute';

// =============================================================================
// Section 20 (Phase 3 / Wave 3 features)
// =============================================================================

// F10: Multi-chain indexer.
// Per-chain env knobs (CHAIN_<chainId>_RPC_URLS, CHAIN_<chainId>_USDT,
// CHAIN_<chainId>_ENABLED, CHAIN_<chainId>_START_BLOCK,
// CHAIN_<chainId>_SCAN_RANGE_BLOCKS, CHAIN_<chainId>_BLOCK_CONFIRMATIONS) are
// dynamic by chainId so they cannot be hard-coded here; the chains.ts loader
// reads them directly. See the comment at the top of src/lib/evm/chains.ts
// for the rationale (this is the ONLY justified bypass of main-config.ts).
export const CHAINS_RATE_LIMIT_MAX: number = Number(process.env.CHAINS_RATE_LIMIT_MAX) || 30;
export const CHAINS_RATE_LIMIT_WINDOW: string =
  process.env.CHAINS_RATE_LIMIT_WINDOW || '1 minute';
export const CHAINS_CACHE_TTL_MS: number = Number(process.env.CHAINS_CACHE_TTL_MS) || 10_000;

// F7: Live match pulse worker.
// Worker no-ops when FOOTBALL_DATA_API_KEY is unset (uses the existing knob
// from the catalog sync feature, declared above). Tier governs whether goal
// events carry scorer/minute detail; default 'free' covers delayed scores only.
const _LIVE_TIER_RAW = (process.env.FOOTBALL_DATA_API_TIER || 'free').toLowerCase();
export const FOOTBALL_DATA_API_TIER: 'free' | 'livescores' =
  _LIVE_TIER_RAW === 'livescores' ? 'livescores' : 'free';
// Competition code defaults to the World Cup ('WC' per the football-data.org
// lookup table). Reused name avoids re-declaring catalog's constant.
export const LIVE_MATCH_PULSE_COMPETITION_CODE: string =
  process.env.FOOTBALL_DATA_COMPETITION_CODE || FOOTBALL_DATA_COMPETITION;
export const LIVE_MATCH_PULSE_CRON: string =
  process.env.LIVE_MATCH_PULSE_CRON || '* * * * *';
export const LIVE_MATCH_PULSE_WINDOW_BEFORE_MIN: number =
  Number(process.env.LIVE_MATCH_PULSE_WINDOW_BEFORE_MIN) || 5;
export const LIVE_MATCH_PULSE_WINDOW_AFTER_MIN: number =
  Number(process.env.LIVE_MATCH_PULSE_WINDOW_AFTER_MIN) || 140;
export const LIVE_MATCH_PULSE_MATCHES_PER_TICK: number =
  Number(process.env.LIVE_MATCH_PULSE_MATCHES_PER_TICK) || 5;
export const LIVE_MATCH_PULSE_CACHE_TTL_MS: number =
  Number(process.env.LIVE_MATCH_PULSE_CACHE_TTL_MS) || 30_000;
export const LIVE_MATCH_RATE_LIMIT_MAX: number =
  Number(process.env.LIVE_MATCH_RATE_LIMIT_MAX) || 60;
export const LIVE_MATCH_RATE_LIMIT_WINDOW: string =
  process.env.LIVE_MATCH_RATE_LIMIT_WINDOW || '1 minute';

// F8: Live demo dashboard. HTML + JSON variants share the same rate-limit
// bucket; HTML cache is longer (the goal of which is server-side stability,
// while the page itself updates live over /activity/stream).
export const DASHBOARD_RATE_LIMIT_MAX: number =
  Number(process.env.DASHBOARD_RATE_LIMIT_MAX) || 30;
export const DASHBOARD_RATE_LIMIT_WINDOW: string =
  process.env.DASHBOARD_RATE_LIMIT_WINDOW || '1 minute';
export const DASHBOARD_HTML_CACHE_TTL_MS: number =
  Number(process.env.DASHBOARD_HTML_CACHE_TTL_MS) || 30_000;
export const DASHBOARD_JSON_CACHE_TTL_MS: number =
  Number(process.env.DASHBOARD_JSON_CACHE_TTL_MS) || 5_000;

// =============================================================================
// Section 21 (Phase 4 / Wave 4 features)
// =============================================================================

// F11: EIP-3009 Facilitator.
// If RELAY_SPONSOR_PK is unset OR RELAY_SPONSOR_ENABLED is false the endpoint
// returns 404 (hide existence, mirroring ADR-007 demo-seed pattern).
// The PK is never logged; the ethers.Wallet retains it internally after
// construction and the local var is dropped from scope. See ADR-010.
export const RELAY_SPONSOR_PK: string | undefined = process.env.RELAY_SPONSOR_PK;
export const RELAY_SPONSOR_ENABLED: boolean =
  (process.env.RELAY_SPONSOR_ENABLED || 'false').toLowerCase() === 'true';
// Human-readable USDT cap per submission. Base-units cap derived from it below.
export const RELAY_MAX_AMOUNT_USDT: string = process.env.RELAY_MAX_AMOUNT_USDT || '100';
// USDT has 6 decimals. 100 USDT -> 100_000_000 base units.
export const RELAY_MAX_AMOUNT_USDT_WEI: bigint =
  BigInt(RELAY_MAX_AMOUNT_USDT) * 1_000_000n;
// Comma-separated list of token contracts the facilitator will relay for. Empty
// list means "no tokens allowed" and every submit returns 400 TOKEN_NOT_ALLOWED.
// Sepolia USDT is the default so a fresh install works out of the box.
export const RELAY_ALLOWED_TOKENS: string[] = (
  process.env.RELAY_ALLOWED_TOKENS || '0xd077a400968890eacc75cdc901f0356c943e4fdb'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
export const RELAY_ONLY_REGISTERED_HOSTS: boolean =
  (process.env.RELAY_ONLY_REGISTERED_HOSTS || 'true').toLowerCase() === 'true';
// Sponsor balance floor in wei. Default 0.005 ETH. Endpoint 503s if the sponsor
// balance drops below this, keeping the sponsor from ever going to zero mid-demo.
export const RELAY_MIN_SPONSOR_BALANCE_WEI: bigint = BigInt(
  process.env.RELAY_MIN_SPONSOR_BALANCE_WEI || '5000000000000000'
);
export const RELAY_RATE_LIMIT_MAX: number = Number(process.env.RELAY_RATE_LIMIT_MAX) || 20;
export const RELAY_RATE_LIMIT_WINDOW: string =
  process.env.RELAY_RATE_LIMIT_WINDOW || '1 minute';
export const RELAY_STATUS_RATE_LIMIT_MAX: number =
  Number(process.env.RELAY_STATUS_RATE_LIMIT_MAX) || 60;
export const RELAY_STATUS_RATE_LIMIT_WINDOW: string =
  process.env.RELAY_STATUS_RATE_LIMIT_WINDOW || '1 minute';
export const RELAY_HEALTH_RATE_LIMIT_MAX: number =
  Number(process.env.RELAY_HEALTH_RATE_LIMIT_MAX) || 30;
export const RELAY_HEALTH_RATE_LIMIT_WINDOW: string =
  process.env.RELAY_HEALTH_RATE_LIMIT_WINDOW || '1 minute';
export const RELAY_CONFIRMATION_CRON: string =
  process.env.RELAY_CONFIRMATION_CRON || '*/15 * * * * *';
// Rows staying in 'submitted' longer than this get marked 'failed' with
// 'confirmation timeout' by the worker. 5 minutes matches Sepolia's practical
// upper bound for a well-formed tx to land during hackathon-scale traffic.
export const RELAY_CONFIRMATION_TIMEOUT_MIN: number =
  Number(process.env.RELAY_CONFIRMATION_TIMEOUT_MIN) || 5;

// F12: QVAC model registry + mirror.
// Mirror is opt-in and off by default. In redirect-only mode (default) the
// backend never touches large model binaries — /qvac/models/:id/download 302s
// to the model's upstream downloadUrl. Turn the mirror on only when a
// persistent volume is provisioned at MODEL_MIRROR_DIR and the operator has
// pinned the sha-256 digest for every model that should be served (see
// ARCHITECTURE.md §21 F12 + ADR-012).
export const MODEL_MIRROR_ENABLED: boolean =
  (process.env.MODEL_MIRROR_ENABLED || 'false').toLowerCase() === 'true';
export const MODEL_MIRROR_DIR: string =
  process.env.MODEL_MIRROR_DIR || './tmp/qvac-models';
export const MODEL_REGISTRY_RATE_LIMIT_MAX: number =
  Number(process.env.MODEL_REGISTRY_RATE_LIMIT_MAX) || 60;
export const MODEL_REGISTRY_RATE_LIMIT_WINDOW: string =
  process.env.MODEL_REGISTRY_RATE_LIMIT_WINDOW || '1 minute';
export const MODEL_DOWNLOAD_RATE_LIMIT_MAX: number =
  Number(process.env.MODEL_DOWNLOAD_RATE_LIMIT_MAX) || 10;
export const MODEL_DOWNLOAD_RATE_LIMIT_WINDOW: string =
  process.env.MODEL_DOWNLOAD_RATE_LIMIT_WINDOW || '1 minute';
export const MODEL_MIRROR_SYNC_CRON: string =
  process.env.MODEL_MIRROR_SYNC_CRON || '0 * * * *';
// Hard bound on a single mirrored download. 128 MB comfortably covers the
// three Bergamot entries (~17 MB each) plus headroom for future Whisper-tiny
// (~40 MB). Prevents a malicious upstream from filling the volume.
export const MODEL_DOWNLOAD_MAX_BYTES: number =
  Number(process.env.MODEL_DOWNLOAD_MAX_BYTES) || 128 * 1024 * 1024;
export const MODEL_REGISTRY_CACHE_MAX_AGE_SECONDS: number =
  Number(process.env.MODEL_REGISTRY_CACHE_MAX_AGE_SECONDS) || 300;

// F13: Pear app distribution.
// Backend maintains a permanent Pears seeder for the Curva Pear app itself and
// exposes a distribution manifest. When PEAR_APP_KEY is unset OR
// PEAR_DISTRIBUTION_ENABLED=false, the manifest still renders (with null
// appKey + seederRunning: false) and the seeder subprocess never spawns.
// Unlike F5/F11 this endpoint does NOT hide existence — the manifest is public
// discovery infra, so operators want a stable URL that returns 200 with a
// "coming soon" shape until the first release drops.
export const PEAR_APP_KEY: string | undefined = process.env.PEAR_APP_KEY;
export const PEAR_APP_VERSION: string = process.env.PEAR_APP_VERSION || '0.0.0-pending';
export const PEAR_APP_RELEASE_DATE: string | undefined = process.env.PEAR_APP_RELEASE_DATE;
export const PEAR_APP_DESCRIPTION: string =
  process.env.PEAR_APP_DESCRIPTION || 'Curva - fully P2P World Cup watch-party app';
export const PEAR_DISTRIBUTION_ENABLED: boolean =
  (process.env.PEAR_DISTRIBUTION_ENABLED || 'false').toLowerCase() === 'true';
export const PEAR_DISTRIBUTION_SEEDER_MAX_RETRIES_PER_HOUR: number =
  Number(process.env.PEAR_DISTRIBUTION_SEEDER_MAX_RETRIES_PER_HOUR) || 5;
export const DISTRIBUTION_RATE_LIMIT_MAX: number =
  Number(process.env.DISTRIBUTION_RATE_LIMIT_MAX) || 60;
export const DISTRIBUTION_RATE_LIMIT_WINDOW: string =
  process.env.DISTRIBUTION_RATE_LIMIT_WINDOW || '1 minute';
export const DISTRIBUTION_CACHE_TTL_MS: number =
  Number(process.env.DISTRIBUTION_CACHE_TTL_MS) || 300_000;

// F14: MCP server (cross-pillar Ardoino vision).
// On-by-default so AI agents can talk to Curva out of the box (per ADR-011).
// When MCP_ACCESS_TOKEN is set, every /mcp/{sse,messages,streamable-http} call
// requires Authorization: Bearer <token>. The token is compared with
// crypto.timingSafeEqual and never logged. /mcp/info stays public either way
// (advertises authRequired: true).
// prepare_tip is gated separately (MCP_TOOL_PREPARE_TIP_ENABLED) because it's
// the tool closest to a value-moving action; keep it off by default in
// production. See ADR-011.
export const MCP_ENABLED: boolean =
  (process.env.MCP_ENABLED || 'true').toLowerCase() === 'true';
export const MCP_ACCESS_TOKEN: string | undefined = process.env.MCP_ACCESS_TOKEN;
// Default off. Operators must explicitly enable this tool AND set
// MCP_ACCESS_TOKEN in production. Enabling without an access token exposes
// host smart-account addresses to anonymous scrapers per OWASP API3:2023.
export const MCP_TOOL_PREPARE_TIP_ENABLED: boolean =
  (process.env.MCP_TOOL_PREPARE_TIP_ENABLED || 'false').toLowerCase() === 'true';
export const MCP_RATE_LIMIT_MAX: number = Number(process.env.MCP_RATE_LIMIT_MAX) || 30;
export const MCP_RATE_LIMIT_WINDOW: string =
  process.env.MCP_RATE_LIMIT_WINDOW || '1 minute';
export const MCP_INFO_RATE_LIMIT_MAX: number =
  Number(process.env.MCP_INFO_RATE_LIMIT_MAX) || 60;
export const MCP_INFO_RATE_LIMIT_WINDOW: string =
  process.env.MCP_INFO_RATE_LIMIT_WINDOW || '1 minute';
export const MCP_MAX_SESSIONS: number =
  Number(process.env.MCP_MAX_SESSIONS) || 200;
// Sessions expire after this many seconds of inactivity.
export const MCP_SESSION_TTL_SECONDS: number =
  Number(process.env.MCP_SESSION_TTL_SECONDS) || 300;

// F9: i18n
// Default language used when ?lang= is absent and Accept-Language matches none
// of the supported tags. Validated inline against the SUPPORTED_LANGS set;
// invalid values silently fall back to 'en' so a typo doesn't crash boot.
const _DEFAULT_LANG_RAW = (process.env.DEFAULT_LANG || 'en').toLowerCase();
export const DEFAULT_LANG: 'en' | 'it' | 'id' =
  _DEFAULT_LANG_RAW === 'en' || _DEFAULT_LANG_RAW === 'it' || _DEFAULT_LANG_RAW === 'id'
    ? _DEFAULT_LANG_RAW
    : 'en';

// =============================================================================
// Wave 7 Zone C: Fiat pricing (Bitfinex + Frankfurter)
// =============================================================================

// Rate limit on GET /pricing/usdt. Cache is 60s in-memory so 60/min/IP is a
// wide-open budget for legit clients (RoomHeader fetches on room open + on
// each tip-amount preset click).
export const PRICING_RATE_LIMIT_MAX: number = Number(process.env.PRICING_RATE_LIMIT_MAX) || 60;
export const PRICING_RATE_LIMIT_WINDOW: string =
  process.env.PRICING_RATE_LIMIT_WINDOW || '1 minute';

// =============================================================================
// Wave 10: Match Prediction Pool
// =============================================================================
//
// Feature-flag gated so the main tip flow and the existing 414 tests are
// unaffected on machines that have not migrated the new Prisma tables. When
// disabled the routes return 503 FEATURE_DISABLED and the settlement worker
// no-ops on every tick.
//
// Docs verified:
//   EIP-3009 validAfter/validBefore semantics — exclusive on both sides
//     (require now > validAfter && now < validBefore). See eips.ethereum.org/EIPS/eip-3009.
//   validBefore may be scheduled far into the future safely per the EIP
//     rationale, so PREDICTIONS_AUTHORIZATION_BUFFER_MIN is a generous 30 min
//     past the pool deadline.
export const CURVA_PREDICTIONS_ENABLED: boolean =
  (process.env.CURVA_PREDICTIONS_ENABLED || 'false').toLowerCase() === 'true';
// Base-units entry stake for winner-only + exact-score pools. USDT has 6
// decimals, so 1_000_000 == 1 USDT. Hard-coded default keeps the ingress
// validator strict: an entry that doesn't match this exact value is rejected.
export const PREDICTIONS_ENTRY_STAKE_ATOMIC: string =
  process.env.PREDICTIONS_ENTRY_STAKE_ATOMIC || '1000000';
// Buffer added to a pool's deadlineMs when validating EIP-3009 validBefore on
// entry submits. If a peer signs at 21:59:59 for a 22:00 deadline, the
// facilitator still needs room to relay after submission. 30 minutes is
// generous enough for Sepolia's practical upper bound while staying tight
// enough that a stale signature can't be replayed weeks later.
export const PREDICTIONS_AUTHORIZATION_BUFFER_MIN: number =
  Number(process.env.PREDICTIONS_AUTHORIZATION_BUFFER_MIN) || 30;
// Settlement worker cadence. 30s balances demo responsiveness against RPC
// budget. Cron notation, matches the F11 confirmation worker's format.
export const PREDICTIONS_SETTLEMENT_CRON: string =
  process.env.PREDICTIONS_SETTLEMENT_CRON || '*/30 * * * * *';
// Per-IP rate limits. Open + result routes are host-privileged so the cap is
// small; entry submits are peer-facing but bounded by the F11 relay cap.
export const PREDICTIONS_OPEN_RATE_LIMIT_MAX: number =
  Number(process.env.PREDICTIONS_OPEN_RATE_LIMIT_MAX) || 5;
export const PREDICTIONS_OPEN_RATE_LIMIT_WINDOW: string =
  process.env.PREDICTIONS_OPEN_RATE_LIMIT_WINDOW || '1 minute';
export const PREDICTIONS_ENTRY_RATE_LIMIT_MAX: number =
  Number(process.env.PREDICTIONS_ENTRY_RATE_LIMIT_MAX) || 20;
export const PREDICTIONS_ENTRY_RATE_LIMIT_WINDOW: string =
  process.env.PREDICTIONS_ENTRY_RATE_LIMIT_WINDOW || '1 minute';
export const PREDICTIONS_READ_RATE_LIMIT_MAX: number =
  Number(process.env.PREDICTIONS_READ_RATE_LIMIT_MAX) || 60;
export const PREDICTIONS_READ_RATE_LIMIT_WINDOW: string =
  process.env.PREDICTIONS_READ_RATE_LIMIT_WINDOW || '1 minute';
// Chain to run pools on. Defaults to Sepolia; must be listed in chains.json
// AND enabled at boot, otherwise /predictions/open returns 400 CHAIN_DISABLED.
export const PREDICTIONS_CHAIN_ID: number =
  Number(process.env.PREDICTIONS_CHAIN_ID) || 11155111;

// =============================================================================
// Wave 13B: WDK x402 paid-resource protocol
// =============================================================================
//
// Feature-flag gated so the routes return 503 FEATURE_DISABLED by default. The
// x402 gateway rides on top of the F11 facilitator, so RELAY_SPONSOR_ENABLED
// must ALSO be true for a payment to settle on-chain. When the flag is off the
// route surfaces zero on-chain risk.
//
// Docs verified:
//   - https://docs.wdk.tether.io/ai/x402/ (WDK-native path)
//   - https://x402.org / https://docs.x402.org/ (canonical standard)
//   - EIP-3009 shared with the F11 facilitator (see notes above).
export const CURVA_X402_ENABLED: boolean =
  (process.env.CURVA_X402_ENABLED || 'false').toLowerCase() === 'true';
// Base-units amount required to unlock the demo resource. 1 USDT = 1_000_000
// (USDT has 6 decimals). Kept small so the demo is cheap to reproduce.
export const CURVA_X402_PRICE_ATOMIC: string =
  process.env.CURVA_X402_PRICE_ATOMIC || '1000000';
// Resource slug the challenge advertises. Whitelisted to a single value; extra
// resources would require new challenges + isolated unlock caches.
export const CURVA_X402_RESOURCE: string =
  process.env.CURVA_X402_RESOURCE || 'premium-translations';
// Chain the challenge is issued on. Must be enabled in chains.ts at boot.
export const CURVA_X402_CHAIN_ID: number =
  Number(process.env.CURVA_X402_CHAIN_ID) || 11155111;
// Token contract the challenge asks payment in. Defaults to Sepolia USDT so a
// fresh install works out of the box; must also be in RELAY_ALLOWED_TOKENS.
export const CURVA_X402_TOKEN_ADDRESS: string = (
  process.env.CURVA_X402_TOKEN_ADDRESS || '0xd077a400968890eacc75cdc901f0356c943e4fdb'
).toLowerCase();
// Recipient of the payment. Defaults to the RELAY sponsor for demo simplicity;
// operators should set an explicit address in production.
export const CURVA_X402_PAY_TO: string = (
  process.env.CURVA_X402_PAY_TO || ''
).toLowerCase();
// Validity window of a challenge in seconds. Short-lived so a stale challenge
// can't be replayed hours later after the user closes the modal.
export const CURVA_X402_CHALLENGE_TTL_SECONDS: number =
  Number(process.env.CURVA_X402_CHALLENGE_TTL_SECONDS) || 15 * 60;
// Per-IP rate limit. The gate returns 402 or 200 depending on payment state
// so we cap probing.
export const CURVA_X402_RATE_LIMIT_MAX: number =
  Number(process.env.CURVA_X402_RATE_LIMIT_MAX) || 20;
export const CURVA_X402_RATE_LIMIT_WINDOW: string =
  process.env.CURVA_X402_RATE_LIMIT_WINDOW || '1 minute';

// =============================================================================
// Wave 14: Attendance Ticket Tools
// =============================================================================
//
// Feature-flag gated so routes return 503 FEATURE_DISABLED by default. The
// verifier is signature-only — no on-chain settlement — so enabling this flag
// has zero economic risk, but keeping it off by default preserves the pre-
// existing test suite unchanged (see backend/CLAUDE.md: never regress).
//
// Docs verified:
//   - https://eips.ethereum.org/EIPS/eip-191 (personal_sign prefix format)
//   - https://docs.ethers.org/v6/api/hashing/#verifyMessage (recovery)
//   - Full memo lives at the top of src/lib/evm/attendance.ts.
export const CURVA_ATTENDANCE_ENABLED: boolean =
  (process.env.CURVA_ATTENDANCE_ENABLED || 'false').toLowerCase() === 'true';
// Max age (seconds) of an attendance pass at verify time. 24h keeps a leaked
// signature narrow-window without breaking the "watch replay" story.
export const CURVA_ATTENDANCE_MAX_AGE_SECONDS: number =
  Number(process.env.CURVA_ATTENDANCE_MAX_AGE_SECONDS) || 60 * 60 * 24;
// Per-IP rate limit on the public verifier route.
export const CURVA_ATTENDANCE_RATE_LIMIT_MAX: number =
  Number(process.env.CURVA_ATTENDANCE_RATE_LIMIT_MAX) || 60;
export const CURVA_ATTENDANCE_RATE_LIMIT_WINDOW: string =
  process.env.CURVA_ATTENDANCE_RATE_LIMIT_WINDOW || '1 minute';

export default {
  APP_PORT,
  NODE_ENV,
  IS_DEV,
  IS_PROD,
  DATABASE_URL,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  ERROR_LOG_MAX_RECORDS,
  ERROR_LOG_CLEANUP_INTERVAL,
  CORS_ORIGINS,
  LANDING_ORIGIN,
  BODY_LIMIT_BYTES,
  TRUST_PROXY_HOPS,
  SEPOLIA_RPC_URLS,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_USDT_ADDRESS,
  USDT_DECIMALS,
  TIP_INDEXER_INTERVAL_CRON,
  TIP_INDEXER_CONFIRMATIONS,
  TIP_INDEXER_MAX_BLOCK_SPAN,
  TIP_INDEXER_BOOTSTRAP_BACKFILL,
  ENABLE_SEEDER,
  SEEDER_NOISE_SEED,
  SEEDER_MAX_ROOMS,
  SEEDER_BARE_ENTRY,
  SEEDER_REGION,
  SEEDER_RECONCILE_CRON,
  FOOTBALL_DATA_API_KEY,
  FOOTBALL_DATA_COMPETITION,
  CATALOG_SYNC_CRON,
  ROOM_RATE_LIMIT_MAX,
  ROOM_RATE_LIMIT_WINDOW,
  ROOM_DELETE_RATE_LIMIT_MAX,
  ROOM_DELETE_RATE_LIMIT_WINDOW,
  ROOM_DELETE_CHALLENGE_RATE_LIMIT_MAX,
  ROOM_DELETE_CHALLENGE_RATE_LIMIT_WINDOW,
  ROOM_POST_MATCH_BUFFER_HOURS,
  ROOM_MATCH_DURATION_HOURS,
  ROOM_CLEANUP_CRON,
  ROOM_CHALLENGE_TTL_SECONDS,
  SERVICE_VERSION,
  SERVICE_STARTED_AT,
};
