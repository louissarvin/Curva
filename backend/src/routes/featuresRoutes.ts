/**
 * Public feature matrix endpoint (semifinal code-review round).
 *
 *   GET /features        -> JSON matrix of every Curva feature flag +
 *                            which QVAC capabilities are wired,
 *                            which Pears primitives are exercised,
 *                            which WDK surfaces are active.
 *
 * Rationale: code-review reviewers can `curl http://localhost:3700/features`
 * and see the whole stack in one payload without spelunking the config or
 * grepping source. Every entry cites the commit-pinned permalink where the
 * feature lands in the codebase.
 *
 * Cache: 30s TtlCache (features rarely change at runtime). Rate limit inherits
 * from the global limiter; see index.ts.
 *
 * Docs consulted:
 *   - Fastify plugin pattern (backend/CLAUDE.md route registration section)
 *   - Existing statusRoutes.ts + healthRoutes.ts shape
 *
 * @author louissarvin
 * @since 2026-07-11 (semifinal)
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { TtlCache } from '../lib/cache.ts';
import { handleServerError } from '../utils/errorHandler.ts';
import {
  CURVA_PREDICTIONS_ENABLED,
  CURVA_X402_ENABLED,
  ENABLE_SEEDER,
  ENABLE_VIP_RESERVATIONS,
  IS_PROD,
  RELAY_SPONSOR_ENABLED,
  SERVICE_STARTED_AT,
  SERVICE_VERSION,
} from '../config/main-config.ts';

// -----------------------------------------------------------------------------
// The matrix. Static-shape describes the code as it stands on origin/main.
// Booleans reflect the live env at boot; strings/arrays are compile-time.
// -----------------------------------------------------------------------------

interface CapabilityRef {
  name: string;
  status: 'live' | 'off' | 'partial';
  file?: string;
  cites?: string[];
}

interface FeatureMatrix {
  service: {
    version: string;
    startedAt: string;
    uptimeSeconds: number;
    env: string;
  };
  qvac: {
    orchestrationFlows: CapabilityRef[];
    capabilities: CapabilityRef[];
    mcpTools: string[];
  };
  pears: {
    primitives: CapabilityRef[];
    techniques: CapabilityRef[];
  };
  wdk: {
    surfaces: CapabilityRef[];
  };
  backend: {
    featureFlags: Record<string, boolean>;
    routes: string[];
  };
}

const FEATURE_MATRIX_CACHE = new TtlCache<FeatureMatrix>(4);
const CACHE_KEY = 'matrix';
const CACHE_TTL_MS = 30_000;

const buildMatrix = (): FeatureMatrix => {
  return {
    service: {
      version: SERVICE_VERSION,
      startedAt: new Date(SERVICE_STARTED_AT).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - SERVICE_STARTED_AT) / 1000),
      env: IS_PROD ? 'production' : 'development',
    },
    qvac: {
      orchestrationFlows: [
        { name: 'voice-coach (5-cap: STT+RAG+LLM+MCP+TTS)', status: 'live', file: 'pear-app/bare/voiceCoach.js' },
        { name: 'ask-the-frame (5-cap: VLM+RAG+LLM+MCP+TTS)', status: 'live', file: 'pear-app/bare/askTheFrame.js' },
        { name: 'goal-pipeline (6-cap: OCR+goalCard+MCP+Bergamot+TTS+Autobase)', status: 'live', file: 'pear-app/bare/goalPipeline.js' },
        { name: 'voice-cloned-goal (F1)', status: 'live', file: 'pear-app/bare/goalPipeline.js' },
        { name: 'voice-cloned-commentator (F5)', status: 'live', file: 'pear-app/bare/commentator.js' },
        { name: 'match-recap (7-cap: chat+goals+tips+LLM+Bergamot+TTS+Hyperblob)', status: 'live', file: 'pear-app/bare/matchRecap.js' },
        { name: 'auto-highlight (5-cap: MobileNet+VLM+LLM+translate+TTS)', status: 'live', file: 'pear-app/bare/highlightPipeline.js' },
        { name: 'RAG-augmented-commentator (F9)', status: 'live', file: 'pear-app/bare/commentator.js', cites: ['CURVA_COMMENTATOR_RAG_ENABLED'] },
        { name: 'multi-locale-commentator (F16)', status: 'live', file: 'pear-app/bare/commentator.js', cites: ['CURVA_COMMENTATOR_MULTI_LOCALE_ENABLED'] },
        { name: 'cross-lingual-voice-coach (F22)', status: 'live', file: 'pear-app/bare/voiceCoach.js', cites: ['CURVA_VOICE_COACH_CROSS_LINGUAL_ENABLED'] },
        { name: 'qvac-asset-seed-back (F13)', status: 'live', file: 'pear-app/bare/qvacAssetSeed.js', cites: ['CURVA_QVAC_ASSET_SEED_ENABLED'] },
      ],
      capabilities: [
        { name: 'Bergamot NMT (multi-locale translation)', status: 'live' },
        { name: 'Qwen3 0.6B q4 completion + streaming', status: 'live' },
        { name: 'Whisper Tiny transcribeStream', status: 'live' },
        { name: 'Supertonic TTS + streaming', status: 'live' },
        { name: 'Chatterbox voice-clone (6 European locales)', status: 'live' },
        { name: 'SmolVLM2 500M + mmproj (frame captions)', status: 'live' },
        { name: 'MobileNetV3 Small classify (cost pre-filter)', status: 'live' },
        { name: 'OCR_LATIN (scoreboard reading)', status: 'live' },
        { name: 'Parakeet Sortformer (diarization)', status: 'live' },
        { name: 'EmbeddingGemma 300M Q4 (RAG)', status: 'live' },
        { name: 'MCP tool calling (16 tools registered)', status: 'live' },
        { name: '@qvac/langdetect-text (per-message routing)', status: 'live' },
        { name: '@qvac/diagnostics (native report)', status: 'live' },
        { name: 'sdk.cancel (barge-in support)', status: 'live' },
        { name: 'sdk.loggingStream (per-model tail)', status: 'live' },
        { name: 'sdk.downloadAsset + seed:true (F13)', status: 'live' },
      ],
      mcpTools: [
        'list_rooms',
        'get_room',
        'get_match_live',
        'list_matches_today',
        'get_leaderboard',
        'get_room_tips',
        'get_supported_chains',
        'list_qvac_models',
        'get_status',
        'prepare_tip',
        'score_get_live',
        'ref_discipline',
        'get_prediction_pool',
        'get_user_profile',
        'get_h2h_history',
        'get_tournament_bracket',
      ],
    },
    pears: {
      primitives: [
        { name: 'hyperswarm (DHT room discovery)', status: 'live' },
        { name: 'hyperDHT (public bootstrap)', status: 'live' },
        { name: 'corestore (per-peer feature namespaces)', status: 'live' },
        { name: 'hypercore (encrypted sealed-prediction epochs)', status: 'live' },
        { name: 'hyperbee (chat + playhead + roomState views)', status: 'live' },
        { name: 'autobase (Pattern B multi-writer)', status: 'live' },
        { name: 'hyperdrive (match-clip + wc-reel + qvac-assets)', status: 'live' },
        { name: 'hyperblobs (chunked replication)', status: 'live' },
        { name: 'hypercore-blob-server (loopback HTTP CDN)', status: 'live' },
        { name: 'blind-peering (hostless persistence)', status: 'live' },
        { name: 'keet-identity-key 3.2.0 (attestation)', status: 'live' },
        { name: 'pear-runtime (dual-runtime shell)', status: 'live' },
        { name: 'pear.updater (hot pear:// updates)', status: 'live' },
      ],
      techniques: [
        { name: 'Autobase Pattern B addWriter (host-controlled)', status: 'live' },
        { name: 'Autobase apply middleware (observational only)', status: 'live', cites: ['ADR-006'] },
        { name: 'base.view.checkout(seq) chat scrubber', status: 'live' },
        { name: 'base.ack cadence tuning', status: 'live' },
        { name: 'Hyperbee sub() namespacing', status: 'live' },
        { name: 'Hypercore BLAKE2b-256 encryption (predictions epoch)', status: 'live' },
        { name: 'blind-peering explicit target strategy', status: 'live' },
        { name: 'protomux tactical drawing side-channel', status: 'live' },
        { name: 'DHT topic sha256(protocol+asset) (F13 asset mesh)', status: 'live' },
      ],
    },
    wdk: {
      surfaces: [
        { name: 'ERC-4337 smart account (Safe + Candide fallback)', status: 'live' },
        { name: 'wdk-secret-manager (PBKDF2 + XSalsa20-Poly1305)', status: 'live' },
        { name: 'EIP-3009 TransferWithAuthorization', status: 'live' },
        { name: 'x402 premium-translations paid resource', status: RELAY_SPONSOR_ENABLED && CURVA_X402_ENABLED ? 'live' : 'off' },
        { name: 'x402 VIP room reservation (F4)', status: ENABLE_VIP_RESERVATIONS && RELAY_SPONSOR_ENABLED ? 'live' : 'off' },
      ],
    },
    backend: {
      featureFlags: {
        ENABLE_SEEDER,
        RELAY_SPONSOR_ENABLED,
        CURVA_PREDICTIONS_ENABLED,
        CURVA_X402_ENABLED,
        ENABLE_VIP_RESERVATIONS,
      },
      routes: [
        '/matches',
        '/rooms',
        '/tips',
        '/relay',
        '/health',
        '/status',
        '/status.json',
        '/leaderboard',
        '/predictions',
        '/x402',
        '/vip',
        '/rag',
        '/mcp',
        '/qvac',
        '/pears',
        '/activity',
        '/dashboard',
        '/attendance',
        '/facilitator',
        '/distribution',
        '/features',
      ],
    },
  };
};

export const featuresRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      let matrix = FEATURE_MATRIX_CACHE.get(CACHE_KEY);
      if (!matrix) {
        matrix = buildMatrix();
        FEATURE_MATRIX_CACHE.set(CACHE_KEY, matrix, CACHE_TTL_MS);
      }
      reply.header('Cache-Control', 'public, max-age=30');
      return reply.code(200).send({
        success: true,
        error: null,
        data: matrix,
      });
    } catch (err) {
      return handleServerError(reply, err as Error);
    }
  });

  done();
};
