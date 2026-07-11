import './dotenv.ts';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import FastifyCors from '@fastify/cors';
import FastifyHelmet from '@fastify/helmet';
import FastifyRateLimit from '@fastify/rate-limit';
import {
  APP_PORT,
  BODY_LIMIT_BYTES,
  CORS_ORIGINS,
  IS_DEV,
  LANDING_ORIGIN,
  SERVICE_VERSION,
  TRUST_PROXY_HOPS,
} from './src/config/main-config.ts';
import { DEFAULT_LANG, resolveLang } from './src/lib/i18n/index.ts';

// Routes
import { matchRoutes } from './src/routes/matchRoutes.ts';
import { matchLiveRoutes } from './src/routes/matchLiveRoutes.ts';
import { matchLiveStreamRoutes } from './src/routes/matchLiveStreamRoutes.ts';
import { teamRoutes } from './src/routes/teamRoutes.ts';
import { roomRoutes } from './src/routes/roomRoutes.ts';
import { tipRoutes } from './src/routes/tipRoutes.ts';
import { relayRoutes } from './src/routes/relayRoutes.ts';
import { featuresRoutes } from './src/routes/featuresRoutes.ts';
import { healthRoutes } from './src/routes/healthRoutes.ts';
import { activityRoutes } from './src/routes/activityRoutes.ts';
import { leaderboardRoutes } from './src/routes/leaderboardRoutes.ts';
import { statusRoutes } from './src/routes/statusRoutes.ts';
import { demoRoutes } from './src/routes/demoRoutes.ts';
import { phrasebookRoutes } from './src/routes/phrasebookRoutes.ts';
import { chainsRoutes } from './src/routes/chainsRoutes.ts';
import { dashboardRoutes } from './src/routes/dashboardRoutes.ts';
import { facilitatorRoutes } from './src/routes/facilitatorRoutes.ts';
import { wdkVerifyRoutes } from './src/routes/wdkVerifyRoutes.ts';
import { wdkAttributionRoutes } from './src/routes/wdkAttributionRoutes.ts';
import { tokenDomainRoutes } from './src/routes/tokenDomainRoutes.ts';
import { qvacRoutes } from './src/routes/qvacRoutes.ts';
import { distributionRoutes } from './src/routes/distributionRoutes.ts';
import { pearsRoutes } from './src/routes/pearsRoutes.ts';
import { pricingRoutes } from './src/routes/pricingRoutes.ts';
import { mcpRoutes, initMcpRegistries } from './src/routes/mcpRoutes.ts';
import { predictionRoutes } from './src/routes/predictionRoutes.ts';
import { x402Routes } from './src/routes/x402Routes.ts';
import { vipRoutes } from './src/routes/vipRoutes.ts';
import { attendanceRoutes } from './src/routes/attendanceRoutes.ts';
import {
  MCP_ENABLED,
  CURVA_PREDICTIONS_ENABLED,
  CURVA_X402_ENABLED,
  ENABLE_VIP_RESERVATIONS,
  CURVA_ATTENDANCE_ENABLED,
  RELAY_DEMO_ENABLED,
  ENABLE_BACKEND_METRICS,
  METRICS_RATE_LIMIT_MAX,
  METRICS_RATE_LIMIT_WINDOW,
  ENABLE_SHARED_RAG,
  ENABLE_MATCH_CLIP_DRIVE,
} from './src/config/main-config.ts';
import { clipsRoutes } from './src/routes/clipsRoutes.ts';
import { initMatchClipDrive, shutdownMatchClipDrive } from './src/lib/pears/matchClipDrive.ts';
import { ragRoutes } from './src/routes/ragRoutes.ts';
import { scrapeMetrics } from './src/lib/observability.ts';
import { getToolCount, getResourceCount } from './src/lib/mcp/server.ts';

// F10: multi-chain awareness — boot log shows which chains are enabled so
// operators see the active scan set at-a-glance.
import { getEnabledChains } from './src/lib/evm/chains.ts';

// Workers
import { startErrorLogCleanupWorker } from './src/workers/errorLogCleanup.ts';
import { startCatalogSyncWorker } from './src/workers/catalogSyncWorker.ts';
import { startTipIndexerWorker } from './src/workers/tipIndexerWorker.ts';
import { startRoomCleanupWorker } from './src/workers/roomCleanupWorker.ts';
import { startSeederReconcileWorker } from './src/workers/seederReconcileWorker.ts';
import { startMatchAutoWarmWorker } from './src/workers/matchAutoWarmWorker.ts';
import { startLiveMatchPulseWorker } from './src/workers/liveMatchPulseWorker.ts';
import { startRelayConfirmationWorker } from './src/workers/relayConfirmationWorker.ts';
import { startModelMirrorSyncWorker } from './src/workers/modelMirrorSyncWorker.ts';
import { startPredictionSettlementWorker } from './src/workers/predictionSettlementWorker.ts';

// Seeder lifecycle
import { seederSupervisor } from './src/lib/pears/seeder.ts';
// F13: Pear app distribution seeder (permanent, one subprocess for the app itself).
import {
  startAppDistributionSeeder,
  stopAppDistributionSeeder,
} from './src/lib/pears/appDistribution.ts';
// Activity event bus — initialized eagerly so any boot-time publisher (workers
// that fire on a short cron) reaches an existing singleton.
import { eventBus } from './src/lib/activity/eventBus.ts';

console.log(
  '\n======================\n  CURVA COMPANION\n  v' +
    SERVICE_VERSION +
    '\n======================\n'
);

const fastify = Fastify({
  logger: false,
  bodyLimit: BODY_LIMIT_BYTES,
  // Numeric hop count is the OWASP-recommended trustProxy shape: trust exactly
  // the configured number of front-facing proxies (Fly.io edge / Railway). A
  // boolean true would trust any X-Forwarded-For value an attacker injects,
  // bypassing per-IP rate limits. See SECURITY_AUDIT.md HIGH-01.
  // Deployment requirement: set TRUST_PROXY_HOPS to the actual number of trusted
  // proxies in front of the app (default 1).
  trustProxy: TRUST_PROXY_HOPS,
});

// =============================================================================
// Helmet — hardened HTTP security headers.
//
// Registered BEFORE CORS so headers are attached on every response, including
// CORS preflight replies. We intentionally set a permissive Content-Security-
// Policy for HTML routes (/dashboard, /status) because ADR-008 requires zero
// build-step, inline-only assets. The dashboard route (dashboardRoutes.ts)
// overrides CSP with a stricter, feature-specific policy on its 200 response;
// helmet's default only applies to responses that do not set their own CSP.
//
// We disable strict-transport-security when NODE_ENV is not production so local
// dev over http://localhost keeps working; helmet enables STS by default with
// max-age 15552000 in prod (see @fastify/helmet docs, Fastify 5 compat).
// =============================================================================

await fastify.register(FastifyHelmet, {
  global: true,
  contentSecurityPolicy: {
    // SECURITY_AUDIT MED-03: global CSP denies script/style by default. This
    // baseline applies to JSON endpoints that never render HTML — no browser
    // should execute code against them. The two HTML routes
    // (dashboardRoutes.ts + statusRoutes.ts) set their own permissive CSP on
    // their 200 responses (@fastify/helmet only applies the default when the
    // response has not set its own Content-Security-Policy header).
    // See: https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  },
  // Local dev over http://localhost cannot use HSTS. Prod default is on.
  strictTransportSecurity: IS_DEV
    ? false
    : { maxAge: 15552000, includeSubDomains: true, preload: false },
  // X-Frame-Options DENY is the safer legacy header pair with CSP
  // frame-ancestors 'none'. Keep it on.
  frameguard: { action: 'deny' },
  // Referrer-Policy stays conservative — see dashboardRoutes.ts comment on
  // why judges pasting screenshot URLs should not leak.
  referrerPolicy: { policy: 'no-referrer' },
});

// =============================================================================
// CORS — locked-down allowlist
// =============================================================================

const ALLOW_LIST = new Set<string>([...CORS_ORIGINS, ...(LANDING_ORIGIN ? [LANDING_ORIGIN] : [])]);

await fastify.register(FastifyCors, {
  origin: (origin, cb) => {
    // No Origin header (curl, native fetch from pear runtime, same-origin) -> allow.
    if (!origin) return cb(null, true);
    if (ALLOW_LIST.has(origin)) return cb(null, true);
    // Pear deeplinks: any pear://* origin is acceptable.
    if (origin.startsWith('pear://')) return cb(null, true);
    // Dev convenience: allow any localhost port.
    if (IS_DEV && /^http:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    return cb(new Error('CORS_NOT_ALLOWED'), false);
  },
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type'],
});

// =============================================================================
// Rate limiting — registered globally OFF, opt-in per route
// =============================================================================

await fastify.register(FastifyRateLimit, {
  global: false,
  // The keyGenerator runs per opt-in route; sourced from trustProxy-resolved IP.
});

// =============================================================================
// i18n (F9) — populate request.lang for every inbound request before any
// route handler runs. The decorator initialiser guarantees `request.lang` is
// always defined even on the rare error-during-onRequest path. See
// ARCHITECTURE.md Section 20 F9.
// =============================================================================

fastify.decorateRequest('lang', DEFAULT_LANG);
fastify.addHook('preHandler', async (request: FastifyRequest) => {
  const q = (request.query as { lang?: unknown } | undefined)?.lang;
  request.lang = resolveLang({
    query: q,
    acceptLanguage: request.headers['accept-language'],
  });
});

// =============================================================================
// Routes
// =============================================================================

// Root: pointer for humans / wake-up ping
fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
  return reply.status(200).send({
    success: true,
    error: null,
    data: { service: 'curva-companion', version: SERVICE_VERSION },
  });
});

await fastify.register(matchRoutes, { prefix: '/matches' });
// F7: live match snapshot endpoint, mounted under the same /matches prefix so
// the final URL reads `/matches/:id/live`.
await fastify.register(matchLiveRoutes, { prefix: '/matches' });
// F3: SSE stream of match.goal / match.score / match.pulse. Mounted alongside
// the REST /matches/:id/live endpoint so the final URL reads
// `/matches/live/stream`.
await fastify.register(matchLiveStreamRoutes, { prefix: '/matches' });
await fastify.register(teamRoutes, { prefix: '/teams' });
await fastify.register(roomRoutes, { prefix: '/rooms' });
await fastify.register(tipRoutes, { prefix: '/tips' });
await fastify.register(relayRoutes, { prefix: '/relay' });
await fastify.register(healthRoutes, { prefix: '/health' });
// NOTE: Legacy `/metrics/live` K8s probe alias removed in wave 3 because
// the new Prometheus exporter below owns the `/metrics` path. K8s liveness
// probes should target `/health/live` (same handler, same shape).

// F3 Prometheus exporter. Public GET /metrics returning the text-format
// registry. Feature-flag gated: when ENABLE_BACKEND_METRICS=false the
// endpoint returns 404 so its existence stays hidden (ADR-010 hide-existence
// posture). Rate-limited per-IP so a broken Prom collector cannot DoS us.
//
// Docs: https://prometheus.io/docs/instrumenting/exposition_formats/
// Docs: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
//       (recommends restricting telemetry endpoints to trusted collectors)
fastify.get(
  '/metrics',
  {
    config: {
      rateLimit: {
        max: METRICS_RATE_LIMIT_MAX,
        timeWindow: METRICS_RATE_LIMIT_WINDOW,
      },
    },
  },
  async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!ENABLE_BACKEND_METRICS) {
      // Hide-existence: return the default Fastify 404 shape by throwing an
      // error the framework converts to 404. reply.callNotFound() is the
      // Fastify 5 idiom.
      reply.callNotFound();
      return reply;
    }
    const scrape = await scrapeMetrics();
    if (!scrape) {
      reply.callNotFound();
      return reply;
    }
    reply.header('Content-Type', scrape.contentType);
    reply.header('Cache-Control', 'no-store');
    return reply.status(200).send(scrape.body);
  }
);
if (ENABLE_BACKEND_METRICS) {
  console.log('[Boot] Backend Prometheus exporter enabled at GET /metrics');
}

// Section 19 (Phase 2) routes
await fastify.register(activityRoutes, { prefix: '/activity' });
await fastify.register(leaderboardRoutes, { prefix: '/leaderboard' });
// statusRoutes declares /status and /status.json itself, no prefix.
await fastify.register(statusRoutes);
// Semifinal code-review helper: GET /features returns the full stack matrix.
await fastify.register(featuresRoutes, { prefix: '/features' });
await fastify.register(demoRoutes, { prefix: '/demo' });
await fastify.register(phrasebookRoutes, { prefix: '/phrasebook' });
// F10 multi-chain registry (no prefix; declares /chains itself).
await fastify.register(chainsRoutes);
// F8 live demo dashboard (no prefix; declares /dashboard + /dashboard.json itself).
await fastify.register(dashboardRoutes);
// F11 EIP-3009 facilitator (Wave 4). Routes mounted under /wdk/relay so the
// public HTTP surface reads /wdk/relay/eip3009, /wdk/relay/status/:txHash,
// /wdk/relay/health. When RELAY_SPONSOR_PK is unset OR RELAY_SPONSOR_ENABLED
// is false, every route in this plugin returns 404 (hide-existence per ADR-010).
await fastify.register(facilitatorRoutes, { prefix: '/wdk/relay' });
if (RELAY_DEMO_ENABLED) {
  // Sponsor-signs-EIP-3009-on-itself endpoint used by the 3-minute stage demo.
  // Path B: sponsor builds and signs a TransferWithAuthorization with
  // from == to == sponsor, then relays it through submitEip3009Relay() — the
  // same code path as POST /wdk/relay/eip3009 — so the tx emits BOTH the
  // ERC-20 Transfer event AND the EIP-3009 AuthorizationUsed event. Gated by
  // RELAY_DEMO_ENABLED so production builds never expose it (route returns
  // 404 when the flag is off).
  // See facilitatorRoutes.ts POST /wdk/relay/demo-self-tip (mode=eip3009_self_tip).
  console.log('[Boot] Demo self-tip route enabled at POST /wdk/relay/demo-self-tip (mode=eip3009_self_tip, sponsor signs transferWithAuthorization on itself; RELAY_DEMO_ENABLED=true)');
} else {
  console.log('[Boot] Demo self-tip route disabled (RELAY_DEMO_ENABLED unset or false; POST /wdk/relay/demo-self-tip returns 404)');
}
// Wave 6 Tier 2: public tip-verification share URL. Reads only FacilitatorTx +
// Room, so it stays available whether the facilitator itself is enabled or not
// (as long as historical rows exist in the DB).
await fastify.register(wdkVerifyRoutes, { prefix: '/wdk/verify' });
// F15 Wave 11 add-on: attribution verification. Decodes the abstractionkit
// onChainIdentifier marker from an ERC-4337 UserOp callData and compares
// against the locally-computed Curva marker. Public, rate-limited to
// 60/min/IP. See src/routes/wdkAttributionRoutes.ts for the docs trail.
await fastify.register(wdkAttributionRoutes, { prefix: '/wdk' });
// Fix Wave B / T3: on-chain EIP-712 domain probe for EIP-3009 tokens. Lets the
// Pear-app wallet fetch the token's actual name()/EIP712_VERSION() at init so
// its client-side digest matches the F11 facilitator's recovery domain.
await fastify.register(tokenDomainRoutes, { prefix: '/wdk' });
// F12 QVAC model registry (Wave 4). Static-JSON catalog + optional mirror.
// Mirror is opt-in via MODEL_MIRROR_ENABLED; default mode 302-redirects to the
// upstream model URL, so this feature has zero runtime dependency on a
// persistent volume in the default deploy.
await fastify.register(qvacRoutes, { prefix: '/qvac' });
// F13 Pear app distribution (Wave 4). Public manifest + permanent seeder.
// Endpoints stay reachable even when PEAR_APP_KEY is unset — they return a
// stable "coming soon" shape so the URL is a discoverable pointer for judges.
await fastify.register(distributionRoutes);
// Live Pears primitives status endpoint. Public snapshot of every Pears
// building block Curva exercises + app key + active rooms + WDK network
// summary. Consumed by the marketing site (SSR /, /architecture) and by
// judges curl-ing to verify real state. Rate-limited 60/min/IP.
await fastify.register(pearsRoutes, { prefix: '/pears' });
// Wave 7 Zone C: Fiat pricing (USDT -> IDR/EUR/GBP/BRL/MXN/JPY/USD).
// Public. 60/min/IP rate limit. Bitfinex (peg) + Frankfurter (ECB refs).
await fastify.register(pricingRoutes, { prefix: '/pricing' });
// F1 Semifinal: Match-clip Hyperdrive manifest. Off by default; hides existence
// (route is never mounted) when ENABLE_MATCH_CLIP_DRIVE=false. See
// src/lib/pears/matchClipDrive.ts for the ingestion + key-derivation flow.
if (ENABLE_MATCH_CLIP_DRIVE) {
  await fastify.register(clipsRoutes, { prefix: '/clips' });
  console.log('[Boot] Match-clip Hyperdrive route enabled at GET /clips/manifest');
}
// Wave 3 F4: shared WC26 fixtures RAG service. Public. Rate-limited.
// Backed by src/data/world-cup-2026.json — real FIFA 2026 draw data seeded
// into the corpus at boot. When ENABLE_SHARED_RAG=false the route plugin
// returns 503 FEATURE_DISABLED on every endpoint.
await fastify.register(ragRoutes, { prefix: '/rag' });
if (ENABLE_SHARED_RAG) {
  console.log('[Boot] Shared RAG enabled at POST /rag/search, GET /rag/status');
}
// Wave 10: Match Prediction Pool. Feature-flag gated (CURVA_PREDICTIONS_ENABLED).
// When disabled, every route in the plugin returns 503 FEATURE_DISABLED, so
// the existing test suite is unaffected even before running `bun run db:push`
// for the new PredictionPool + Prediction tables.
await fastify.register(predictionRoutes, { prefix: '/predictions' });
// Wave 13B: WDK x402 paid-resource gateway. Feature-flag gated
// (CURVA_X402_ENABLED, default false). When disabled the route returns
// 503 FEATURE_DISABLED so the existing test suite is unaffected. Rides on
// top of the F11 facilitator, so RELAY_SPONSOR_ENABLED must also be true
// for a payment to actually settle on-chain.
await fastify.register(x402Routes, { prefix: '/x402' });
if (CURVA_X402_ENABLED) {
  console.log('[Boot] x402 paid-resource gateway enabled at GET /x402/*');
}
// Semifinal Wave: VIP room slug reservations. Second x402 endpoint (rides on
// the same F11 facilitator). Mounted ONLY when ENABLE_VIP_RESERVATIONS=true so
// that a fresh deploy without the flag returns 404 (hide-existence per
// ADR-010) rather than 503 — matches the demo-seed and MCP patterns.
if (ENABLE_VIP_RESERVATIONS) {
  await fastify.register(vipRoutes, { prefix: '/vip' });
  console.log(
    '[Boot] VIP reservation gateway enabled at POST /vip/reserve, GET /vip/status/:slug'
  );
}
// Wave 14: Attendance Ticket Tools. Feature-flag gated (CURVA_ATTENDANCE_ENABLED,
// default false). When disabled the route returns 503 FEATURE_DISABLED so the
// existing test suite is unaffected. Off-chain EIP-191 verifier — no on-chain
// settlement, no economic risk on enable.
await fastify.register(attendanceRoutes, { prefix: '/wdk/verify-attendance' });
if (CURVA_ATTENDANCE_ENABLED) {
  console.log('[Boot] Attendance verifier enabled at GET /wdk/verify-attendance/:slug/:address');
}
// F14 MCP server (Wave 4, cross-pillar Ardoino vision). Public-by-default per
// ADR-011; optional bearer via MCP_ACCESS_TOKEN. When MCP_ENABLED=false the
// plugin registers no routes and requests get the default Fastify 404 —
// indistinguishable from a build without MCP.
if (MCP_ENABLED) {
  await initMcpRegistries();
  console.log(
    `[Boot] MCP server enabled: ${getToolCount()} tools, ${getResourceCount()} resources at /mcp/*`
  );
}
await fastify.register(mcpRoutes);

// =============================================================================
// Graceful shutdown
// =============================================================================

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] Received ${signal}, draining...`);
  try {
    // Close every SSE subscription so the kernel TCP buffers drain on the
    // outbound side before Fastify finishes shutting down its listeners.
    eventBus.closeAll();
    await fastify.close();
    await seederSupervisor.shutdown();
    // F13 distribution seeder shutdown. No-op when the seeder was never spawned
    // (disabled mode), so safe to call unconditionally.
    await stopAppDistributionSeeder();
    await shutdownMatchClipDrive();
    console.log('[Shutdown] Done. Bye.');
    process.exit(0);
  } catch (err) {
    console.error('[Shutdown] Error during shutdown:', err);
    process.exit(1);
  }
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Unhandled promise rejections: log loudly but don't crash (workers shouldn't take down API).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// =============================================================================
// Boot
// =============================================================================

const start = async (): Promise<void> => {
  try {
    // F10: boot-time visibility into the multi-chain config so operators see
    // the active scan set at-a-glance. Plasma logs as disabled until USDT0
    // ships (CHAIN_9746_USDT + CHAIN_9746_ENABLED=true).
    try {
      const enabledChains = getEnabledChains();
      if (enabledChains.length === 0) {
        console.warn('[Boot] No chains enabled — tip indexer will idle until configured.');
      } else {
        console.log(
          `[Boot] Enabled chains: ${enabledChains
            .map((c) => `${c.chainId}/${c.name}`)
            .join(', ')}`
        );
      }
    } catch (err) {
      console.error('[Boot] chains.ts misconfigured:', (err as Error)?.message);
    }

    // Workers first so the rest of the system can rely on them being scheduled.
    startErrorLogCleanupWorker();
    startCatalogSyncWorker();
    startRoomCleanupWorker();
    startTipIndexerWorker();
    startSeederReconcileWorker();
    startMatchAutoWarmWorker();
    startLiveMatchPulseWorker();
    // F11 confirmation worker no-ops when the facilitator is disabled; safe to
    // schedule unconditionally.
    startRelayConfirmationWorker();
    // F12 mirror sync worker no-ops when MODEL_MIRROR_ENABLED=false (default);
    // safe to schedule unconditionally.
    startModelMirrorSyncWorker();
    // F13 distribution seeder. No-ops when PEAR_APP_KEY is unset OR
    // PEAR_DISTRIBUTION_ENABLED=false; safe to call unconditionally at boot.
    startAppDistributionSeeder();
    // F1 Semifinal: match-clip Hyperdrive ingestion. Runs only when the flag is
    // on. Never throws — a failed init leaves the manifest in { ready:false }.
    if (ENABLE_MATCH_CLIP_DRIVE) {
      await initMatchClipDrive();
    }
    // Wave 10 settlement worker. No-ops when CURVA_PREDICTIONS_ENABLED=false;
    // safe to schedule unconditionally.
    startPredictionSettlementWorker();
    if (CURVA_PREDICTIONS_ENABLED) {
      console.log('[Boot] Prediction pools enabled (POST /predictions/*, settlement worker active)');
    }

    await fastify.listen({
      port: APP_PORT,
      host: '0.0.0.0',
    });

    const address = fastify.server.address();
    const port = typeof address === 'object' && address ? address.port : APP_PORT;

    console.log(`[Boot] Server listening on http://localhost:${port}`);
  } catch (err) {
    console.error('[Boot] Failed to start:', err);
    process.exit(1);
  }
};

void start();
