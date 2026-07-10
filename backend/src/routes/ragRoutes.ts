/**
 * F4 Wave 3: Shared RAG endpoints.
 *
 *   POST /rag/search   body: { query, topK?, kind? }  → hits[]
 *   GET  /rag/status                                    → corpus size + last ingest
 *
 * Docs consulted (fetched 2026-07-10):
 *   https://docs.qvac.tether.io/ai-capabilities/rag/
 *   https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html
 *   https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
 *
 * When ENABLE_SHARED_RAG=false every route in this plugin returns
 * 503 FEATURE_DISABLED so the existing test surface is unaffected.
 */

import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  ENABLE_SHARED_RAG,
  RAG_RATE_LIMIT_MAX,
  RAG_RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';
import { search, getStatus, type RagDoc } from '../lib/qvac/sharedRag.ts';
import { recordRagSearch } from '../lib/observability.ts';

const KIND_ALLOWED: ReadonlySet<RagDoc['kind']> = new Set([
  'team',
  'match',
  'group',
  'meta',
]);

const disabledResponse = (reply: FastifyReply): FastifyReply =>
  handleError(
    reply,
    503,
    'Shared RAG is disabled',
    'FEATURE_DISABLED'
  ) as unknown as FastifyReply;

export const ragRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // ---------------------------------------------------------------------------
  // GET /rag/status
  // ---------------------------------------------------------------------------
  app.get(
    '/status',
    {
      config: {
        rateLimit: {
          max: RAG_RATE_LIMIT_MAX,
          timeWindow: RAG_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      if (!ENABLE_SHARED_RAG) return disabledResponse(reply);
      try {
        const status = getStatus();
        reply.header('Cache-Control', 'public, max-age=60');
        return reply.code(200).send({
          success: true,
          error: null,
          data: status,
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // POST /rag/search
  // ---------------------------------------------------------------------------
  app.post(
    '/search',
    {
      config: {
        rateLimit: {
          max: RAG_RATE_LIMIT_MAX,
          timeWindow: RAG_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!ENABLE_SHARED_RAG) return disabledResponse(reply);
      try {
        const body = (request.body || {}) as Record<string, unknown>;
        const query = typeof body.query === 'string' ? body.query.trim() : '';
        if (!query) {
          return handleError(
            reply,
            400,
            'query is required',
            'INVALID_QUERY'
          );
        }
        if (query.length > 256) {
          return handleError(
            reply,
            400,
            'query too long (max 256 chars)',
            'QUERY_TOO_LONG'
          );
        }
        const topK = typeof body.topK === 'number' ? body.topK : undefined;
        const kindInput = body.kind;
        let kind: RagDoc['kind'] | undefined;
        if (kindInput !== undefined) {
          if (
            typeof kindInput !== 'string' ||
            !KIND_ALLOWED.has(kindInput as RagDoc['kind'])
          ) {
            return handleError(
              reply,
              400,
              'kind must be one of team|match|group|meta',
              'INVALID_KIND'
            );
          }
          kind = kindInput as RagDoc['kind'];
        }
        const hits = search({ query, topK, kind });
        recordRagSearch('wc26', hits.length > 0 ? 'hit' : 'miss');
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            query,
            topK: hits.length,
            hits,
          },
        });
      } catch (err) {
        recordRagSearch('wc26', 'error');
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
