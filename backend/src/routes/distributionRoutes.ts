/**
 * F13: Pear app distribution manifest routes.
 *
 *   GET /distribution            human-readable JSON manifest
 *   GET /distribution.pear.json  raw machine-readable manifest (Pear updater)
 *
 * Both are public, rate-limited (60/min/IP), and cache-friendly (5min TTL). The
 * endpoint is designed to be safe to hit even when the Pear app hasn't shipped
 * a first release — it returns 200 with `appKey: null` + `seederRunning: false`
 * so the URL is a stable "coming soon" page rather than a 404.
 *
 * NOTE: `/distribution.pear.json` is a raw JSON envelope (no `{ success, error,
 * data }` wrapper). Third documented exception (after F1 SSE and any other
 * flat-schema distribution artefacts). Justification: Pear CLI / updater tools
 * consume the flat schema; wrapping it would break third-party interop.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  DISTRIBUTION_CACHE_TTL_MS,
  DISTRIBUTION_RATE_LIMIT_MAX,
  DISTRIBUTION_RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';
import { handleServerError } from '../utils/errorHandler.ts';
import {
  getConfig,
  getInstallInstructions,
  getStatus,
} from '../lib/pears/appDistribution.ts';

const cacheSeconds = Math.floor(DISTRIBUTION_CACHE_TTL_MS / 1000);

export const distributionRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // ---------------------------------------------------------------------------
  // GET /distribution
  // ---------------------------------------------------------------------------
  app.get(
    '/distribution',
    {
      config: {
        rateLimit: {
          max: DISTRIBUTION_RATE_LIMIT_MAX,
          timeWindow: DISTRIBUTION_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const cfg = getConfig();
        const status = getStatus();
        const install = getInstallInstructions();

        reply.header('Cache-Control', `public, max-age=${cacheSeconds}`);
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            appKey: cfg.appKey,
            pearLink: cfg.appKey ? `pear://${cfg.appKey}` : null,
            version: cfg.version,
            releasedAt: cfg.releasedAt,
            description: cfg.description,
            howToInstall: install,
            seederRunning: status.seederRunning,
            seederUptimeSeconds: status.seederUptimeSeconds ?? 0,
            distributionEnabled: cfg.enabled,
            // Future: multi-region mirrors registry (empty list stays stable).
            mirrors: [] as Array<{ region: string; url: string }>,
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // GET /distribution.pear.json
  // Raw envelope for Pear CLI / updater tools. Documented exception to the
  // standard { success, error, data } shape per ARCH §21 F13.
  // ---------------------------------------------------------------------------
  app.get(
    '/distribution.pear.json',
    {
      config: {
        rateLimit: {
          max: DISTRIBUTION_RATE_LIMIT_MAX,
          timeWindow: DISTRIBUTION_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const cfg = getConfig();

        reply.header('Cache-Control', `public, max-age=${cacheSeconds}`);
        reply.header('Content-Type', 'application/json; charset=utf-8');
        // Flat schema; no { success, error, data } wrapper.
        return reply.code(200).send({
          $schema: 'https://curva.app/schemas/pear-distribution.v1.json',
          app: 'curva',
          key: cfg.appKey,
          version: cfg.version,
          released_at: cfg.releasedAt,
          checksums: {},
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
