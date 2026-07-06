/**
 * F6 route tests for /phrasebook.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

const { phrasebookRoutes } = await import('../../src/routes/phrasebookRoutes.ts');
const Fastify = (await import('fastify')).default;
const FastifyRateLimit = (await import('@fastify/rate-limit')).default;

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(FastifyRateLimit, { global: false });
  await app.register(phrasebookRoutes, { prefix: '/phrasebook' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /phrasebook', () => {
  test('returns full payload', async () => {
    const res = await app.inject({ method: 'GET', url: '/phrasebook' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { quotes: unknown[]; italian_phrases: unknown[] };
    };
    expect(Array.isArray(body.data.quotes)).toBe(true);
    expect(Array.isArray(body.data.italian_phrases)).toBe(true);
    // Backend-maximization pass expanded the phrasebook from 6 to 8 quotes.
    // Two Tether hint-category quotes were added for the Pears mapping row.
    expect(body.data.quotes.length).toBe(8);
    expect(body.data.italian_phrases.length).toBe(2);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  test('?lang=it returns only italian_phrases', async () => {
    const res = await app.inject({ method: 'GET', url: '/phrasebook?lang=it' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    expect(body.data.italian_phrases).toBeDefined();
    expect(body.data.quotes).toBeUndefined();
  });

  test('no quote is misattributed to "Tether Developers Cup" (reviewer BLOCKER)', async () => {
    // Reviewer flagged two entries where Curva paraphrases of Tether hint
    // categories were misattributed to Tether. Speaker must never be the raw
    // "Tether Developers Cup" string on any quote we ship.
    const res = await app.inject({ method: 'GET', url: '/phrasebook' });
    const body = res.json() as {
      data: {
        quotes: Array<{ speaker: string; attribution: string }>;
      };
    };
    for (const q of body.data.quotes) {
      expect(q.speaker).not.toBe('Tether Developers Cup');
      expect(q.attribution).not.toBe('Tether Developers Cup');
    }
  });

  test('Wave 15 goal_templates ships all 7 target locales', async () => {
    const res = await app.inject({ method: 'GET', url: '/phrasebook' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { goal_templates: Record<string, string> };
    };
    expect(body.data.goal_templates).toBeDefined();
    const locales = Object.keys(body.data.goal_templates);
    expect(locales.sort()).toEqual(['de', 'en', 'es', 'fr', 'id', 'it', 'pt']);
    // Every template contains all four placeholder tokens (except {minute},
    // which the memo lists as optional in the current template shape).
    for (const [locale, tmpl] of Object.entries(body.data.goal_templates)) {
      expect(typeof tmpl).toBe('string');
      expect(tmpl).toContain('{scorer}');
      expect(tmpl).toContain('{team}');
      expect(tmpl).toContain('{score}');
      // Locale-specific sanity checks to catch accidental swaps.
      if (locale === 'en') expect(tmpl.startsWith('Goal!')).toBe(true);
      if (locale === 'it') expect(tmpl.startsWith('Gol!')).toBe(true);
      if (locale === 'de') expect(tmpl.startsWith('Tor!')).toBe(true);
    }
  });

  test('every pillared quote is attributed to Ardoino or Curva team (verified sources only)', async () => {
    // Every quote with a pillar must have a real, human speaker. Accept both
    // "Paolo Ardoino" (verified public quotes) and "Curva team" (internal copy
    // that may sit in the phrasebook without pretending to be Ardoino).
    const res = await app.inject({ method: 'GET', url: '/phrasebook' });
    const body = res.json() as {
      data: {
        quotes: Array<{ speaker: string; pillar?: string }>;
      };
    };
    const allowedSpeakers = new Set(['Paolo Ardoino', 'Curva team']);
    for (const q of body.data.quotes) {
      if (q.pillar) {
        expect(allowedSpeakers.has(q.speaker)).toBe(true);
      }
    }
  });
});
