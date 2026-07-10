/**
 * F1: Match-clip Hyperdrive manifest route.
 *
 *   GET /clips/manifest
 *
 * Public, rate-limited, cache-friendly. Returns the drive key + discovery key
 * so peers can dial the swarm topic and replicate the clip drive read-only.
 *
 * Registered in `index.ts` ONLY when ENABLE_MATCH_CLIP_DRIVE=true — when the
 * flag is off the endpoint does not exist, matching the ADR-010 hide-existence
 * posture used by demo/facilitator routes.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  CLIP_DRIVE_RATE_LIMIT_MAX,
  CLIP_DRIVE_RATE_LIMIT_WINDOW,
  CLIP_DRIVE_CACHE_TTL_MS,
} from '../config/main-config.ts';
import { handleServerError } from '../utils/errorHandler.ts';
import { getManifest } from '../lib/pears/matchClipDrive.ts';

const cacheSeconds = Math.max(0, Math.floor(CLIP_DRIVE_CACHE_TTL_MS / 1000));

export const clipsRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done,
) => {
  app.get(
    '/manifest',
    {
      config: {
        rateLimit: {
          max: CLIP_DRIVE_RATE_LIMIT_MAX,
          timeWindow: CLIP_DRIVE_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const manifest = getManifest();
        reply.header('Cache-Control', `public, max-age=${cacheSeconds}`);
        return reply.code(200).send({
          success: true,
          error: null,
          data: manifest,
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    },
  );

  done();
};
