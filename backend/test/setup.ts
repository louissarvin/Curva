// Test setup: inject the env vars that main-config.ts validates at module load
// time. This file is preloaded for `bun test` via bunfig.toml.

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt';
process.env.SEPOLIA_RPC_URLS ||= 'https://ethereum-sepolia-rpc.publicnode.com';
process.env.SEEDER_NOISE_SEED ||= '0000000000000000000000000000000000000000000000000000000000000000';
process.env.NODE_ENV ||= 'test';
// Force-disable the seeder in tests so we don't spawn subprocesses.
process.env.ENABLE_SEEDER = 'false';
// Disable rate limit interference in tests.
process.env.ROOM_RATE_LIMIT_MAX = '10000';
process.env.ROOM_DELETE_RATE_LIMIT_MAX = '10000';
process.env.ROOM_DELETE_CHALLENGE_RATE_LIMIT_MAX = '10000';
process.env.LEADERBOARD_RATE_LIMIT_MAX = '10000';
process.env.STATUS_RATE_LIMIT_MAX = '10000';
process.env.DEMO_SEED_RATE_LIMIT_MAX = '10000';
process.env.PHRASEBOOK_RATE_LIMIT_MAX = '10000';
process.env.ACTIVITY_HISTORY_RATE_LIMIT_MAX = '10000';
process.env.DISTRIBUTION_RATE_LIMIT_MAX = '10000';
// Default per-IP SSE cap to 5 (matches production). Individual tests can
// override before importing the activity route module.
process.env.SSE_MAX_CONNECTIONS_PER_IP ||= '5';

// F7 live match pulse worker test posture. Setting these here means the
// liveMatchPulseWorker test can import the worker (and main-config) without
// the module-load-time gate flipping it to disabled mode.
process.env.FOOTBALL_DATA_API_KEY ||= 'test-football-data-key';

// Section 19 (Phase 2) test env. Setting these here means main-config.ts
// captures them at first import regardless of which test file loads first.
// Individual test files can still override before importing the route module
// via mock.module hooks if they need a different posture.
process.env.AUTO_WARM_HOST_OWNER_ADDRESS ||= '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.AUTO_WARM_HOST_SMART_ADDRESS ||= '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
process.env.DEMO_SEED_TOKEN ||= 'test-token-123';
process.env.DEMO_WALLET_SUD_OWNER ||= '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.DEMO_WALLET_SUD_SMART ||= '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
process.env.DEMO_WALLET_NORD_OWNER ||= '0xcccccccccccccccccccccccccccccccccccccccc';
process.env.DEMO_WALLET_NORD_SMART ||= '0xdddddddddddddddddddddddddddddddddddddddd';
