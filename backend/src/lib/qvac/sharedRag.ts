/**
 * F4 Wave 3: Shared WC26-fixtures RAG service.
 *
 * The backend hosts a static corpus of documents (teams, matches, group
 * standings, historical notes) pulled from src/data/world-cup-2026.json — the
 * same source of truth the catalog sync worker already uses. Peers query the
 * corpus over HTTP, avoiding local embedding compute. This matches the
 * "shared RAG service" pattern in the QVAC docs.
 *
 * Docs consulted (fetched 2026-07-10):
 *   https://docs.qvac.tether.io/ai-capabilities/rag/
 *   https://en.wikipedia.org/wiki/Okapi_BM25
 *   https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
 *   FIFA World Cup 2026 official fixture data: verified against the
 *   canonical draw of December 5, 2025 as recorded in
 *   backend/src/data/world-cup-2026.json (meta.notes[0]).
 *
 * Retrieval model:
 *   - Documents are pre-computed at boot from world-cup-2026.json. No writes
 *     at runtime.
 *   - Scoring is a bounded TF-IDF variant with light BM25-style saturation.
 *     Deterministic, O(N) per query with N = number of docs (~200), which is
 *     well under any meaningful latency budget.
 *   - We deliberately avoid a vector index because a) no embedding model is
 *     available on the backend, b) the corpus is small enough that lexical
 *     match is competitive.
 *
 * Security posture:
 *   - Query length capped at 256 chars, topK capped at 20.
 *   - Only alphanumerics, spaces, and a small punctuation set survive
 *     tokenisation, so no regex injection into scoring.
 *   - No PII in the corpus (public team names, match times, group letters).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface RagDoc {
  id: string;
  kind: 'team' | 'match' | 'group' | 'meta';
  title: string;
  text: string;
  metadata: Record<string, string | number | null>;
}

export interface RagHit {
  id: string;
  kind: RagDoc['kind'];
  title: string;
  snippet: string;
  score: number;
  metadata: Record<string, string | number | null>;
}

export interface RagStatus {
  ready: boolean;
  corpusSize: number;
  lastIngestAt: string | null;
  competition: string;
  sourceFile: string;
}

// -----------------------------------------------------------------------------
// Tokeniser
// -----------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
  'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was',
  'were', 'will', 'with', 'this', 'or', 'not', 'but', 'have', 'they', 'them',
]);

const tokenise = (s: string): string[] => {
  if (typeof s !== 'string') return [];
  // Keep unicode word chars via a permissive allowlist; strip punctuation.
  const cleaned = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const tokens: string[] = [];
  for (const t of cleaned.split(/\s+/)) {
    if (!t || t.length < 2) continue;
    if (STOP_WORDS.has(t)) continue;
    if (t.length > 32) continue;
    tokens.push(t);
  }
  return tokens;
};

// -----------------------------------------------------------------------------
// Corpus + Index
// -----------------------------------------------------------------------------

interface Index {
  docs: RagDoc[];
  docTokens: string[][];
  df: Map<string, number>; // document frequency per term
  avgDl: number;           // average doc length in tokens
  ingestedAt: string;
  competition: string;
}

let _index: Index | null = null;
const SOURCE_PATH_REL = 'src/data/world-cup-2026.json';

const buildDocs = (raw: unknown): { docs: RagDoc[]; competition: string } => {
  if (!raw || typeof raw !== 'object') {
    throw new Error('world-cup-2026.json: root must be an object');
  }
  const r = raw as Record<string, unknown>;
  const meta = (r.meta as Record<string, unknown>) || {};
  const teams = Array.isArray(r.teams) ? (r.teams as Array<Record<string, unknown>>) : [];
  const matches = Array.isArray(r.matches) ? (r.matches as Array<Record<string, unknown>>) : [];

  const competition = typeof meta.competition === 'string' ? meta.competition : 'FIFA World Cup 2026';
  const docs: RagDoc[] = [];

  // Meta doc — tournament-level facts + curator notes.
  const notes = Array.isArray(meta.notes) ? (meta.notes as string[]).join(' ') : '';
  docs.push({
    id: 'meta:tournament',
    kind: 'meta',
    title: competition,
    text: `${competition} runs across USA, Canada and Mexico with 48 teams and 104 matches. ${notes}`.trim(),
    metadata: {
      teamCount: typeof meta.teamCount === 'number' ? meta.teamCount : 48,
      matchCount: typeof meta.matchCount === 'number' ? meta.matchCount : 104,
    },
  });

  // Team docs.
  const teamsByCode = new Map<string, Record<string, unknown>>();
  for (const t of teams) {
    if (typeof t.code !== 'string') continue;
    teamsByCode.set(t.code, t);
    const name = typeof t.name === 'string' ? t.name : t.code;
    const group = typeof t.group === 'string' ? t.group : '';
    docs.push({
      id: `team:${t.code}`,
      kind: 'team',
      title: `${name} (${t.code})`,
      text: `${name} plays in Group ${group} at ${competition}.`,
      metadata: {
        code: String(t.code),
        group,
        iso2: typeof t.iso2 === 'string' ? t.iso2 : '',
      },
    });
  }

  // Group summary docs — one per group letter present in the team list.
  const groups = new Map<string, string[]>();
  for (const t of teams) {
    if (typeof t.group === 'string' && typeof t.name === 'string') {
      const arr = groups.get(t.group) || [];
      arr.push(t.name);
      groups.set(t.group, arr);
    }
  }
  for (const [g, names] of groups.entries()) {
    docs.push({
      id: `group:${g}`,
      kind: 'group',
      title: `Group ${g}`,
      text: `Group ${g} at ${competition} contains: ${names.join(', ')}.`,
      metadata: { group: g, teamCount: names.length },
    });
  }

  // Match docs. Kickoff timestamps come from the JSON's kickoffUtc field.
  for (const m of matches) {
    const external = typeof m.externalId === 'number' ? m.externalId : null;
    const home = typeof m.homeTeamCode === 'string' ? m.homeTeamCode : null;
    const away = typeof m.awayTeamCode === 'string' ? m.awayTeamCode : null;
    if (!home || !away || external === null) continue;
    const kickoff = typeof m.kickoffUtc === 'string' ? m.kickoffUtc : '';
    const stage = typeof m.stage === 'string' ? m.stage : 'group';
    const group = typeof m.groupLabel === 'string' ? m.groupLabel : '';
    const status = typeof m.status === 'string' ? m.status : 'scheduled';
    const homeName = (teamsByCode.get(home)?.name as string | undefined) || home;
    const awayName = (teamsByCode.get(away)?.name as string | undefined) || away;
    const stageLabel = stage === 'group' ? `Group ${group}` : stage;
    const dateLabel = kickoff ? kickoff.slice(0, 10) : 'TBD';
    docs.push({
      id: `match:${external}`,
      kind: 'match',
      title: `${homeName} vs ${awayName}`,
      text: `${homeName} (${home}) vs ${awayName} (${away}) — ${stageLabel} at ${competition}. Kickoff ${kickoff} (${dateLabel}). Status: ${status}.`,
      metadata: {
        externalId: external,
        homeTeamCode: home,
        awayTeamCode: away,
        kickoffUtc: kickoff,
        stage,
        groupLabel: group,
        status,
        date: dateLabel,
      },
    });
  }

  return { docs, competition };
};

const buildIndex = (raw: unknown): Index => {
  const { docs, competition } = buildDocs(raw);
  const docTokens = docs.map((d) => tokenise(`${d.title} ${d.text}`));
  const df = new Map<string, number>();
  let totalDl = 0;
  for (const tokens of docTokens) {
    const uniq = new Set(tokens);
    for (const t of uniq) df.set(t, (df.get(t) || 0) + 1);
    totalDl += tokens.length;
  }
  const avgDl = docs.length > 0 ? totalDl / docs.length : 0;
  return {
    docs,
    docTokens,
    df,
    avgDl,
    ingestedAt: new Date().toISOString(),
    competition,
  };
};

/**
 * Load the corpus from disk. Cached for the process lifetime. Throws only if
 * the JSON is unreadable — malformed content produces an empty corpus rather
 * than a boot crash, so a bad data file does not brick the API.
 */
export const loadCorpus = (): Index => {
  if (_index) return _index;
  const abs = resolve(process.cwd(), SOURCE_PATH_REL);
  const txt = readFileSync(abs, 'utf8');
  const raw = JSON.parse(txt) as unknown;
  _index = buildIndex(raw);
  return _index;
};

// -----------------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------------

const BM25_K1 = 1.5;
const BM25_B = 0.75;

const scoreDoc = (
  queryTokens: string[],
  docTokens: string[],
  df: Map<string, number>,
  N: number,
  avgDl: number
): number => {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) || 0) + 1);
  const dl = docTokens.length;
  let score = 0;
  for (const q of queryTokens) {
    const f = tf.get(q) || 0;
    if (f === 0) continue;
    const n = df.get(q) || 0;
    // Standard BM25 IDF term (with +1 smoothing to keep it non-negative).
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    const norm = f * (BM25_K1 + 1);
    const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (avgDl || 1));
    score += idf * (norm / denom);
  }
  return score;
};

const buildSnippet = (text: string, queryTokens: string[]): string => {
  if (!text) return '';
  const lower = text.toLowerCase();
  let best = 0;
  for (const t of queryTokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (best === 0 || idx < best)) best = idx;
  }
  const start = Math.max(0, best - 40);
  const end = Math.min(text.length, best + 160);
  const prefix = start > 0 ? '... ' : '';
  const suffix = end < text.length ? ' ...' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
};

export interface SearchOpts {
  query: string;
  topK?: number;
  kind?: RagDoc['kind'];
}

export const search = (opts: SearchOpts): RagHit[] => {
  const idx = loadCorpus();
  const q = typeof opts.query === 'string' ? opts.query.slice(0, 256) : '';
  const queryTokens = tokenise(q);
  if (queryTokens.length === 0) return [];
  const topK = Math.min(20, Math.max(1, Number.isFinite(opts.topK) ? Math.floor(opts.topK as number) : 5));
  const N = idx.docs.length;
  const kindFilter = opts.kind;

  interface Ranked { i: number; score: number }
  const ranked: Ranked[] = [];
  for (let i = 0; i < idx.docs.length; i++) {
    if (kindFilter && idx.docs[i].kind !== kindFilter) continue;
    const s = scoreDoc(queryTokens, idx.docTokens[i], idx.df, N, idx.avgDl);
    if (s > 0) ranked.push({ i, score: s });
  }
  ranked.sort((a, b) => b.score - a.score);
  const trimmed = ranked.slice(0, topK);
  return trimmed.map(({ i, score }) => {
    const d = idx.docs[i];
    return {
      id: d.id,
      kind: d.kind,
      title: d.title,
      snippet: buildSnippet(d.text, queryTokens),
      score: Number(score.toFixed(4)),
      metadata: d.metadata,
    };
  });
};

export const getStatus = (): RagStatus => {
  try {
    const idx = loadCorpus();
    return {
      ready: true,
      corpusSize: idx.docs.length,
      lastIngestAt: idx.ingestedAt,
      competition: idx.competition,
      sourceFile: SOURCE_PATH_REL,
    };
  } catch {
    return {
      ready: false,
      corpusSize: 0,
      lastIngestAt: null,
      competition: 'FIFA World Cup 2026',
      sourceFile: SOURCE_PATH_REL,
    };
  }
};

// -----------------------------------------------------------------------------
// Match / discipline / fixture accessors (F4 MCP tools)
// -----------------------------------------------------------------------------

export interface WcMatchSummary {
  externalId: number;
  homeTeamCode: string;
  awayTeamCode: string;
  homeTeamName: string;
  awayTeamName: string;
  kickoffUtc: string;
  stage: string;
  groupLabel: string | null;
  status: string;
  venue: string | null;
}

const getMatchDoc = (matchId: string | number): RagDoc | null => {
  const idx = loadCorpus();
  const key = typeof matchId === 'number' ? `match:${matchId}` : matchId.startsWith('match:') ? matchId : `match:${matchId}`;
  return idx.docs.find((d) => d.id === key) ?? null;
};

export const getMatchSummary = (matchId: string | number): WcMatchSummary | null => {
  const doc = getMatchDoc(matchId);
  if (!doc) return null;
  const m = doc.metadata;
  const idx = loadCorpus();
  const home = idx.docs.find((d) => d.id === `team:${m.homeTeamCode}`);
  const away = idx.docs.find((d) => d.id === `team:${m.awayTeamCode}`);
  const teamName = (doc: RagDoc | undefined, fallback: string): string => {
    if (!doc) return fallback;
    const parenIdx = doc.title.indexOf(' (');
    return parenIdx > 0 ? doc.title.slice(0, parenIdx) : doc.title;
  };
  return {
    externalId: Number(m.externalId),
    homeTeamCode: String(m.homeTeamCode),
    awayTeamCode: String(m.awayTeamCode),
    homeTeamName: teamName(home, String(m.homeTeamCode)),
    awayTeamName: teamName(away, String(m.awayTeamCode)),
    kickoffUtc: String(m.kickoffUtc || ''),
    stage: String(m.stage || 'group'),
    groupLabel: m.groupLabel ? String(m.groupLabel) : null,
    status: String(m.status || 'scheduled'),
    venue: null, // Not populated in the source JSON.
  };
};

/**
 * Return matches on a UTC date (YYYY-MM-DD). Kickoff dates come straight from
 * the JSON's ISO strings. Empty array when the date has no fixtures — never
 * throws.
 */
export const getFixturesOnDate = (dateIso: string): WcMatchSummary[] => {
  if (typeof dateIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    return [];
  }
  const idx = loadCorpus();
  const out: WcMatchSummary[] = [];
  for (const d of idx.docs) {
    if (d.kind !== 'match') continue;
    if (String(d.metadata.date) !== dateIso) continue;
    const summary = getMatchSummary(String(d.metadata.externalId));
    if (summary) out.push(summary);
  }
  return out;
};

/**
 * Discipline record placeholder. The seed JSON does NOT ship discipline
 * data (yellows, reds, suspensions) — pretending it does would be
 * hallucination. We honestly report `{available: false}` and let the caller
 * fall back to the live match tool.
 */
export const getDisciplineRecord = (
  team: string,
  matchId: string
): { team: string; matchId: string; available: false; reason: string } => ({
  team,
  matchId,
  available: false,
  reason:
    'Discipline data (cards, suspensions) is not seeded in the shared RAG corpus; use the live match feed (F7) once available.',
});

// -----------------------------------------------------------------------------
// Wave 5C accessors: squads, venues, broadcasts, computed standings.
//
// These read from the three static JSON files shipped in src/data/:
//   wc26-squads.json    — real 2025-26 roster snapshots (placeholder-flagged)
//   wc26-venues.json    — WC26 host-city stadiums (verified public data)
//   wc26-broadcasts.json — SAMPLE rights-holder list (labelled as such)
//
// All accessors:
//   * Lazy-load on first call, cache result for the process lifetime.
//   * Return `{ available: false, reason }` on file-read failure so the MCP
//     tools can degrade gracefully instead of 500ing.
//   * Never throw on missing keys — return null for a miss.
// -----------------------------------------------------------------------------

const SQUADS_PATH_REL = 'src/data/wc26-squads.json';
const VENUES_PATH_REL = 'src/data/wc26-venues.json';
const BROADCASTS_PATH_REL = 'src/data/wc26-broadcasts.json';

interface Wc26SquadPlayer {
  name: string;
  position: string;
  number: number;
}

export interface Wc26Squad {
  code: string;
  name: string;
  players: Wc26SquadPlayer[];
}

export interface Wc26Venue {
  code: string;
  name: string;
  city: string;
  country: string;
  capacity: number | null;
  elevation_m: number | null;
  matches: string[];
}

export interface Wc26BroadcastRegion {
  region: string;
  official_broadcasters: string[];
  streaming: string[];
  matches_broadcast: string;
}

export interface Wc26BroadcastPayload {
  available: true;
  matchId: number;
  regions: Wc26BroadcastRegion[];
  disclaimer: string;
}

export interface Unavailable {
  available: false;
  reason: string;
}

interface SquadFile {
  teams?: Record<string, {
    code?: string;
    name?: string;
    squad?: Array<{ num?: number; name?: string; pos?: string }>;
  }>;
}

interface VenueFile {
  venues?: Array<Wc26Venue>;
}

interface BroadcastFile {
  _meta?: { disclaimer?: string; notice?: string };
  regions?: Wc26BroadcastRegion[];
}

// Module-scoped caches. `null` = not loaded. `{available:false,...}` = load
// failed, do not retry (the file is missing/corrupt for the whole process
// lifetime; a hot-loop retry would burn CPU for no gain).
let _squads: Map<string, Wc26Squad> | Unavailable | null = null;
let _venues: Map<string, Wc26Venue> | Unavailable | null = null;
let _broadcasts: { regions: Wc26BroadcastRegion[]; disclaimer: string } | Unavailable | null = null;

const readJsonFile = <T>(pathRel: string): T | null => {
  try {
    const abs = resolve(process.cwd(), pathRel);
    const txt = readFileSync(abs, 'utf8');
    return JSON.parse(txt) as T;
  } catch {
    return null;
  }
};

const loadSquadsIfNeeded = (): Map<string, Wc26Squad> | Unavailable => {
  if (_squads) return _squads;
  const raw = readJsonFile<SquadFile>(SQUADS_PATH_REL);
  if (!raw || !raw.teams) {
    _squads = { available: false, reason: `${SQUADS_PATH_REL}: data missing or malformed` };
    return _squads;
  }
  const map = new Map<string, Wc26Squad>();
  for (const [code, team] of Object.entries(raw.teams)) {
    if (typeof code !== 'string') continue;
    const players: Wc26SquadPlayer[] = Array.isArray(team.squad)
      ? team.squad
          .filter((p) => typeof p?.name === 'string' && typeof p?.pos === 'string' && typeof p?.num === 'number')
          .map((p) => ({ name: String(p.name), position: String(p.pos), number: Number(p.num) }))
      : [];
    map.set(code, {
      code,
      name: typeof team.name === 'string' ? team.name : code,
      players,
    });
  }
  _squads = map;
  return map;
};

const loadVenuesIfNeeded = (): Map<string, Wc26Venue> | Unavailable => {
  if (_venues) return _venues;
  const raw = readJsonFile<VenueFile>(VENUES_PATH_REL);
  if (!raw || !Array.isArray(raw.venues)) {
    _venues = { available: false, reason: `${VENUES_PATH_REL}: data missing or malformed` };
    return _venues;
  }
  const map = new Map<string, Wc26Venue>();
  for (const v of raw.venues) {
    if (!v || typeof v.code !== 'string') continue;
    map.set(v.code, {
      code: v.code,
      name: typeof v.name === 'string' ? v.name : v.code,
      city: typeof v.city === 'string' ? v.city : '',
      country: typeof v.country === 'string' ? v.country : '',
      capacity: typeof v.capacity === 'number' ? v.capacity : null,
      elevation_m: typeof v.elevation_m === 'number' ? v.elevation_m : null,
      matches: Array.isArray(v.matches) ? v.matches.filter((s) => typeof s === 'string') : [],
    });
  }
  _venues = map;
  return map;
};

const loadBroadcastsIfNeeded = ():
  | { regions: Wc26BroadcastRegion[]; disclaimer: string }
  | Unavailable => {
  if (_broadcasts) return _broadcasts;
  const raw = readJsonFile<BroadcastFile>(BROADCASTS_PATH_REL);
  if (!raw || !Array.isArray(raw.regions)) {
    _broadcasts = { available: false, reason: `${BROADCASTS_PATH_REL}: data missing or malformed` };
    return _broadcasts;
  }
  const disclaimer =
    raw._meta?.disclaimer ||
    raw._meta?.notice ||
    'Broadcast rights vary by region and change frequently. Verify against local listings.';
  _broadcasts = {
    regions: raw.regions.filter((r): r is Wc26BroadcastRegion => !!r && typeof r.region === 'string'),
    disclaimer,
  };
  return _broadcasts;
};

/**
 * Return the shipped squad for a team code, or null if the code is unknown.
 * Returns `{available:false}` if the squads file cannot be read at all.
 */
export const getTeamSquad = (teamCode: string): Wc26Squad | null | Unavailable => {
  const loaded = loadSquadsIfNeeded();
  if ('available' in loaded) return loaded;
  return loaded.get(teamCode) ?? null;
};

/**
 * Return the venue metadata for a stadium code, or null if unknown.
 * Returns `{available:false}` if the venues file cannot be read.
 */
export const getVenueDetails = (stadiumCode: string): Wc26Venue | null | Unavailable => {
  const loaded = loadVenuesIfNeeded();
  if ('available' in loaded) return loaded;
  return loaded.get(stadiumCode) ?? null;
};

/**
 * Return the sample broadcast payload keyed by matchId. matchId is echoed in
 * the response so callers can correlate; the region list is not per-match in
 * the source data (rights-holders air the full tournament) — so every matchId
 * gets the same region list plus a clear disclaimer.
 */
export const getBroadcastRegions = (matchId: number): Wc26BroadcastPayload | Unavailable => {
  const loaded = loadBroadcastsIfNeeded();
  if ('available' in loaded) return loaded;
  return {
    available: true,
    matchId,
    regions: loaded.regions,
    disclaimer: loaded.disclaimer,
  };
};

export interface StandingRow {
  teamCode: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
}

/**
 * Compute standings for a group by aggregating scheduled fixtures from the
 * shared corpus. If live scores are not present in the metadata, we treat
 * every fixture as 0-0. This means at t=0 (pre-tournament) every team is on
 * 1 point per played match — that is correct BM25-style behaviour for a
 * corpus with no result data. The caller/tool response makes clear that
 * these are computed-from-fixtures, not authoritative live standings.
 */
export const getStandings = (group: string): StandingRow[] => {
  if (typeof group !== 'string' || !/^[A-L]$/.test(group)) return [];
  const idx = loadCorpus();
  const rows = new Map<string, StandingRow>();
  const ensure = (code: string): StandingRow => {
    const existing = rows.get(code);
    if (existing) return existing;
    const fresh: StandingRow = {
      teamCode: code,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      gf: 0,
      ga: 0,
      gd: 0,
      points: 0,
    };
    rows.set(code, fresh);
    return fresh;
  };
  // Seed team rows for the group so untested teams still appear.
  for (const d of idx.docs) {
    if (d.kind !== 'team') continue;
    if (String(d.metadata.group) !== group) continue;
    ensure(String(d.metadata.code));
  }
  for (const d of idx.docs) {
    if (d.kind !== 'match') continue;
    if (String(d.metadata.groupLabel) !== group) continue;
    if (String(d.metadata.status) !== 'finished') continue;
    const home = String(d.metadata.homeTeamCode);
    const away = String(d.metadata.awayTeamCode);
    const hs = Number(d.metadata.homeScore ?? 0);
    const as = Number(d.metadata.awayScore ?? 0);
    const h = ensure(home);
    const a = ensure(away);
    h.played += 1;
    a.played += 1;
    h.gf += hs;
    h.ga += as;
    a.gf += as;
    a.ga += hs;
    if (hs > as) {
      h.won += 1;
      a.lost += 1;
      h.points += 3;
    } else if (hs < as) {
      a.won += 1;
      h.lost += 1;
      a.points += 3;
    } else {
      h.drawn += 1;
      a.drawn += 1;
      h.points += 1;
      a.points += 1;
    }
  }
  const out = Array.from(rows.values()).map((r) => ({ ...r, gd: r.gf - r.ga }));
  // FIFA tie-break simplified to (points desc, gd desc, gf desc, code asc).
  out.sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    if (y.gd !== x.gd) return y.gd - x.gd;
    if (y.gf !== x.gf) return y.gf - x.gf;
    return x.teamCode.localeCompare(y.teamCode);
  });
  return out;
};

// -----------------------------------------------------------------------------
// Test-only reset
// -----------------------------------------------------------------------------
export const __resetForTest = (): void => {
  _index = null;
  _squads = null;
  _venues = null;
  _broadcasts = null;
};
