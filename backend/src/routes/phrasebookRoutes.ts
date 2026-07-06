/**
 * Phrasebook endpoint (F6).
 *
 *   GET /phrasebook            — full payload (quotes + italian_phrases)
 *   GET /phrasebook?lang=it    — italian_phrases only
 *
 * Source: src/data/phrasebook.json. Read once at boot, frozen in module scope.
 * Cache: HTTP-layer (immutable). Rate limit 30/min/IP for consistency.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  PHRASEBOOK_RATE_LIMIT_MAX,
  PHRASEBOOK_RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';
import { handleServerError } from '../utils/errorHandler.ts';
import { isSupportedLang, resolveLang } from '../lib/i18n/index.ts';

interface PhrasebookQuote {
  id: string;
  text: string;
  track: string;
  speaker: string;
  // Additive fields for the Cup demo (backend-maximization pass). Existing
  // callers ignore unknown fields; the dashboard/status render `text` + `speaker`
  // only, so these are safe to expose.
  attribution?: string;
  pillar?: 'pears' | 'wdk' | 'qvac' | 'all';
  mapsTo?: string;
}

interface PhrasebookPhrase {
  id: string;
  text: string;
  translation: string;
}

// Wave 15: goal_templates keyed by locale; used by the Supertonic TTS
// announcer to interpolate {team}/{scorer}/{score}/{minute} at synthesis time.
type PhrasebookGoalTemplates = Record<string, string>;

interface PhrasebookData {
  quotes: PhrasebookQuote[];
  italian_phrases: PhrasebookPhrase[];
  goal_templates?: PhrasebookGoalTemplates;
}

// Read once at boot and freeze. If the file is missing or malformed we log and
// continue with an empty structure — never crash the server for a static asset.
const loadPhrasebook = (): Readonly<PhrasebookData> => {
  try {
    const txt = readFileSync(resolve(process.cwd(), 'src/data/phrasebook.json'), 'utf8');
    const parsed = JSON.parse(txt) as PhrasebookData;
    return Object.freeze({
      quotes: Object.freeze([...(parsed.quotes ?? [])]) as PhrasebookQuote[],
      italian_phrases: Object.freeze([...(parsed.italian_phrases ?? [])]) as PhrasebookPhrase[],
      goal_templates: Object.freeze({ ...(parsed.goal_templates ?? {}) }) as PhrasebookGoalTemplates,
    });
  } catch (err) {
    console.warn('[Phrasebook] failed to load src/data/phrasebook.json:', (err as Error)?.message);
    return Object.freeze({ quotes: [], italian_phrases: [], goal_templates: {} });
  }
};

const PHRASEBOOK = loadPhrasebook();

export const phrasebookRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  app.get(
    '/',
    {
      config: {
        rateLimit: { max: PHRASEBOOK_RATE_LIMIT_MAX, timeWindow: PHRASEBOOK_RATE_LIMIT_WINDOW },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // F9: resolve lang from `?lang=` first, then Accept-Language. We retain
        // the original payload-shape contract: `?lang=it` returns the trimmed
        // italian_phrases-only view; every other resolved lang (including the
        // default and Bahasa Indonesia per ARCH §20 F9) returns the full payload.
        const q = (request.query || {}) as Record<string, unknown>;
        const lang = isSupportedLang(q.lang)
          ? q.lang
          : resolveLang({
              query: q.lang,
              acceptLanguage: request.headers['accept-language'],
            });
        reply.header('Cache-Control', 'public, max-age=600, immutable');
        if (lang === 'it') {
          return reply.code(200).send({
            success: true,
            error: null,
            data: { italian_phrases: PHRASEBOOK.italian_phrases },
          });
        }
        return reply.code(200).send({
          success: true,
          error: null,
          data: PHRASEBOOK,
        });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
