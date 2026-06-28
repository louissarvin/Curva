/**
 * Fastify type augmentations (F9 i18n).
 *
 * Adds `request.lang` so route handlers and the centralized error handler can
 * pick the resolved language without re-parsing headers on every call.
 * Populated by the global `preHandler` registered in `index.ts`.
 */

import type { Lang } from '../lib/i18n/index.ts';

declare module 'fastify' {
  interface FastifyRequest {
    lang: Lang;
  }
}

export {};
