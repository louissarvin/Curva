/**
 * F12 QVAC model registry routes.
 *
 *   GET /qvac/models                 catalog (rate 60/min/IP, cache 5min)
 *   GET /qvac/models/:id             one model
 *   GET /qvac/models/:id/download    stream (mirror) or 302 redirect (default)
 *
 * Redirect vs stream is governed by MODEL_MIRROR_ENABLED and by whether a
 * verified local copy exists. Integrity is non-negotiable when mirroring —
 * a null contentDigest or a mismatched local file both refuse to stream
 * (per ADR-012).
 *
 * Range requests: single byte-range only, no multipart/byteranges. Out-of-
 * bounds ranges return 416 with Content-Range 'bytes STAR/total' (RFC 9110).
 */

import { createReadStream, promises as fsp } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  MODEL_DOWNLOAD_RATE_LIMIT_MAX,
  MODEL_DOWNLOAD_RATE_LIMIT_WINDOW,
  MODEL_MIRROR_ENABLED,
  MODEL_REGISTRY_CACHE_MAX_AGE_SECONDS,
  MODEL_REGISTRY_RATE_LIMIT_MAX,
  MODEL_REGISTRY_RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';
import { handleError, handleServerError } from '../utils/errorHandler.ts';
import {
  getModel,
  listModels,
  loadRegistry,
  type QvacModel,
} from '../lib/qvac/registry.ts';
import {
  getMirrorPath,
  hexToBase64,
  parseExpectedDigestHex,
  readyMirroredFile,
} from '../lib/qvac/mirror.ts';
import {
  getDelegatedProvider,
  getDelegatedProviderStateSnapshot,
} from '../lib/qvac/delegatedProvider.ts';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Model ids in the shipped catalog match this; validating here also blocks
// path traversal from ever reaching `getMirrorPath` (defense in depth).
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const isValidId = (id: unknown): id is string =>
  typeof id === 'string' && ID_PATTERN.test(id);

/**
 * Present a model to the caller. `mirrorUrl` is a same-origin download link
 * when the mirror is enabled AND a verified local file exists; otherwise
 * it stays null so the client knows to download from `downloadUrl` directly.
 */
const presentModel = async (
  m: QvacModel,
  mirrorEnabled: boolean
): Promise<QvacModel> => {
  if (!mirrorEnabled) {
    // Even with mirror off we may already have a stale JSON `mirrorUrl`; strip.
    return { ...m, mirrorUrl: null };
  }
  const ready = await readyMirroredFile(m.id, m.contentDigest).catch(() => null);
  return { ...m, mirrorUrl: ready ? `/qvac/models/${m.id}/download` : null };
};

interface ParsedRange {
  start: number;
  end: number; // inclusive
}

/**
 * Parse a single-range `bytes=start-end`, `bytes=start-`, or `bytes=-suffix`.
 * Returns { start, end } inclusive both ends, clamped to [0, size-1], or null
 * if the header is syntactically invalid, or `oob` if it parses but is out of
 * bounds (416).
 */
const parseRangeHeader = (
  header: string | undefined,
  size: number
): ParsedRange | 'oob' | null => {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m) return 'oob';
  const startStr = m[1];
  const endStr = m[2];
  if (startStr === '' && endStr === '') return 'oob';

  let start: number;
  let end: number;
  if (startStr === '') {
    // Suffix range: last N bytes.
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'oob';
    if (suffix >= size) {
      start = 0;
    } else {
      start = size - suffix;
    }
    end = size - 1;
  } else {
    start = Number(startStr);
    if (endStr === '') {
      end = size - 1;
    } else {
      end = Number(endStr);
    }
  }
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return 'oob';
  }
  if (end >= size) end = size - 1;
  return { start, end };
};

// -----------------------------------------------------------------------------
// Route plugin
// -----------------------------------------------------------------------------

export const qvacRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // Eager load so any structural fault in qvac-models.json surfaces at boot.
  try {
    loadRegistry();
  } catch (err) {
    console.error(
      '[qvacRoutes] FATAL: qvac-models.json failed to load —',
      (err as Error)?.message
    );
    throw err;
  }

  // ---------------------------------------------------------------------------
  // GET /qvac/models
  // ---------------------------------------------------------------------------
  app.get(
    '/models',
    {
      config: {
        rateLimit: {
          max: MODEL_REGISTRY_RATE_LIMIT_MAX,
          timeWindow: MODEL_REGISTRY_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const q = (request.query || {}) as Record<string, unknown>;
        const family =
          typeof q.family === 'string' && q.family ? q.family : undefined;
        const capability =
          typeof q.capability === 'string' && q.capability ? q.capability : undefined;
        const reg = loadRegistry();
        const filtered = listModels({ family, capability });
        const presented = await Promise.all(
          filtered.map((m) => presentModel(m, MODEL_MIRROR_ENABLED))
        );
        reply.header(
          'Cache-Control',
          `public, max-age=${MODEL_REGISTRY_CACHE_MAX_AGE_SECONDS}`
        );
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            version: reg.version,
            generatedAt: reg.generatedAt,
            mirrorEnabled: MODEL_MIRROR_ENABLED,
            models: presented,
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // GET /qvac/models/:id
  // ---------------------------------------------------------------------------
  app.get(
    '/models/:id',
    {
      config: {
        rateLimit: {
          max: MODEL_REGISTRY_RATE_LIMIT_MAX,
          timeWindow: MODEL_REGISTRY_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;
        if (!isValidId(id)) {
          return handleError(reply, 404, 'Model not found', 'MODEL_NOT_FOUND');
        }
        const model = getModel(id);
        if (!model) {
          return handleError(reply, 404, 'Model not found', 'MODEL_NOT_FOUND');
        }
        const presented = await presentModel(model, MODEL_MIRROR_ENABLED);
        reply.header(
          'Cache-Control',
          `public, max-age=${MODEL_REGISTRY_CACHE_MAX_AGE_SECONDS}`
        );
        return reply.code(200).send({
          success: true,
          error: null,
          data: { model: presented },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // GET /qvac/models/:id/download
  // ---------------------------------------------------------------------------
  app.get(
    '/models/:id/download',
    {
      config: {
        rateLimit: {
          max: MODEL_DOWNLOAD_RATE_LIMIT_MAX,
          timeWindow: MODEL_DOWNLOAD_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { id } = request.params;
        if (!isValidId(id)) {
          return handleError(reply, 404, 'Model not found', 'MODEL_NOT_FOUND');
        }
        const model = getModel(id);
        if (!model) {
          return handleError(reply, 404, 'Model not found', 'MODEL_NOT_FOUND');
        }

        // Redirect-mode fallbacks (any of the following → 302 upstream, or 503
        // if the upstream itself is not yet available).
        const redirectToUpstream = (): FastifyReply | Promise<FastifyReply> => {
          if (!model.downloadUrl) {
            // W4 CR-Major#3: route through handleError so ErrorLog is written
            // and the response envelope stays consistent with the rest of the
            // API.
            return handleError(
              reply,
              503,
              'Model is not yet published upstream',
              'MODEL_NOT_YET_PUBLISHED'
            ) as unknown as FastifyReply;
          }
          reply.header('X-Curva-Mirror', 'disabled');
          reply.header('Cache-Control', 'no-store');
          return reply.redirect(model.downloadUrl, 302);
        };

        // 1) Mirror disabled → redirect (or 503 if pending-upstream).
        if (!MODEL_MIRROR_ENABLED) {
          if (model.status === 'pending-upstream' && !model.downloadUrl) {
            return handleError(
              reply,
              503,
              'Model is not yet published upstream',
              'MODEL_NOT_YET_PUBLISHED'
            );
          }
          return redirectToUpstream();
        }

        // 2) Mirror ON but no pinned digest → refuse to serve unverified bytes.
        const expectedHex = parseExpectedDigestHex(model.contentDigest);
        if (!expectedHex) {
          // Fall back to upstream redirect; do not stream unverifiable bytes.
          if (model.downloadUrl) {
            reply.header('X-Curva-Mirror', 'unverified');
            reply.header('Cache-Control', 'no-store');
            return reply.redirect(model.downloadUrl, 302);
          }
          return handleError(
            reply,
            503,
            'Model integrity cannot be verified',
            'MODEL_INTEGRITY_UNVERIFIED'
          );
        }

        // 3) Mirror ON, digest known → try to serve locally. If the file is
        // missing or its digest does not match, fall back to redirect.
        let localSize: number | null = null;
        try {
          const path = getMirrorPath(id);
          const st = await fsp.stat(path).catch(() => null);
          if (st && st.isFile()) localSize = st.size;
        } catch {
          /* unsafe id already caught above; ignore */
        }

        if (localSize === null) {
          // No local file — redirect (with a hint the mirror was expected).
          reply.header('X-Curva-Mirror', 'missing');
          reply.header('Cache-Control', 'no-store');
          return reply.redirect(model.downloadUrl, 302);
        }

        // Streaming digest verification per-request would be expensive on large
        // files, but 17 MB is fine and the alternative (trusting mtime) opens
        // a TOCTOU window. Verify unconditionally.
        const ready = await readyMirroredFile(id, model.contentDigest);
        if (!ready) {
          // File exists but digest mismatch — never serve; redirect and log.
          console.warn(
            `[qvacRoutes] mirror digest mismatch for ${id}, falling back to upstream`
          );
          reply.header('X-Curva-Mirror', 'corrupt');
          reply.header('Cache-Control', 'no-store');
          return reply.redirect(model.downloadUrl, 302);
        }

        // 4) Serve. Common headers.
        const rangeHeader = request.headers['range'] as string | undefined;
        const size = ready.size;
        const parsed = parseRangeHeader(rangeHeader, size);
        const contentDigestHeader = `sha-256=:${hexToBase64(ready.digestHex)}:`;
        const etag = `"${ready.digestHex}"`;

        // Etag hit short-circuit — clients that already have this exact byte
        // sequence can skip the transfer entirely.
        const ifNoneMatch = request.headers['if-none-match'];
        if (ifNoneMatch === etag) {
          reply.header('ETag', etag);
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
          return reply.code(304).send();
        }

        // Range-error short-circuit: return the JSON envelope from handleError
        // BEFORE we set Content-Type: application/octet-stream, otherwise
        // Fastify refuses to serialise the error payload as JSON.
        if (parsed === 'oob') {
          reply.header('Content-Range', `bytes */${size}`);
          reply.header('Accept-Ranges', 'bytes');
          return handleError(
            reply,
            416,
            'Invalid range request',
            'INVALID_RANGE'
          );
        }

        // Common headers on every 200/206.
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Digest', contentDigestHeader);
        reply.header('Digest', `sha-256=${hexToBase64(ready.digestHex)}`); // legacy RFC 3230
        reply.header('ETag', etag);
        reply.header('Accept-Ranges', 'bytes');
        reply.header('X-Curva-Mirror', 'hit');
        reply.header('X-Curva-Model-Id', model.id);
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');

        if (parsed === null) {
          // Full-content response — stream via createReadStream so the heap
          // never holds the full file. Files are bounded to
          // MODEL_DOWNLOAD_MAX_BYTES (default 128 MB) at mirror-ingest time;
          // buffering them was a W4-HIGH-02 OOM vector under concurrent
          // slow-reader downloads.
          reply.header('Content-Length', String(size));
          const stream = createReadStream(ready.path);
          return reply.code(200).send(stream);
        }

        // 206 Partial Content — stream the requested slice directly.
        const { start, end } = parsed;
        const length = end - start + 1;
        reply.header('Content-Length', String(length));
        reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
        const rangeStream = createReadStream(ready.path, { start, end });
        return reply.code(206).send(rangeStream);
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // ---------------------------------------------------------------------------
  // GET /qvac/explainer
  //
  // Small, static explainer used by the renderer's About screen (Wave 6). The
  // content lives here (not the JSON registry) because it is UI copy, not a
  // model catalog — a JSON PR to change wording feels heavier than a code PR
  // and we want the same rate-limit as the rest of /qvac/*.
  //
  // No auth. Cache-safe. Rate-limited per-IP.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // GET /qvac/provider (F2 Wave 3)
  //
  // Report the current state of the backend's delegated QVAC provider:
  //   { status: 'disabled'|'unavailable'|'starting'|'running'|'failed',
  //     publicKey: <hex>|null, firewall: {...}, models: [...] }
  //
  // On first call (when ENABLE_QVAC_PROVIDER=true) this lazily boots the
  // provider. Subsequent calls are O(1). Rate-limited so the boot race
  // cannot be triggered repeatedly by an attacker probing the endpoint.
  //
  // Public — the provider pubkey MUST be discoverable so peers can wire
  // `qvacDelegated: {publicKey}` in their registry.
  // ---------------------------------------------------------------------------
  app.get(
    '/provider',
    {
      config: {
        rateLimit: {
          max: MODEL_REGISTRY_RATE_LIMIT_MAX,
          timeWindow: MODEL_REGISTRY_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Query cheap snapshot first so we do not race the lazy start on the
        // read path if it is already resolved.
        const cheap = getDelegatedProviderStateSnapshot();
        const report = cheap.status === 'disabled' || cheap.status === 'running' || cheap.status === 'failed' || cheap.status === 'unavailable'
          ? cheap
          : await getDelegatedProvider();
        // Never cache — the report can transition starting -> running.
        reply.header('Cache-Control', 'no-store');
        return reply.code(200).send({
          success: true,
          error: null,
          data: report,
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  app.get(
    '/explainer',
    {
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        reply.header(
          'Cache-Control',
          `public, max-age=${MODEL_REGISTRY_CACHE_MAX_AGE_SECONDS}`
        );
        return reply.code(200).send({
          success: true,
          error: null,
          data: {
            title: 'Why QVAC not cloud',
            bullets: [
              'Your chat never leaves your device, not even to translate.',
              'Works offline, on airport wifi, during internet shutdowns.',
              'Bergamot NMT models are verified against sha256 on your machine.',
            ],
            attribution:
              'Powered by Bergamot NMT via QVAC. Models from Mozilla firefox-translations-models.',
            sourceUrl: 'https://github.com/mozilla/firefox-translations-models',
          },
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
