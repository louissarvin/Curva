/**
 * F8 Live Demo Dashboard (ARCHITECTURE.md Section 20 + ADR-008).
 *
 *   GET /dashboard           — self-contained HTML; subscribes to /activity/stream
 *   GET /dashboard.json      — JSON envelope of the initial hydration state
 *
 * Per ADR-008: zero build step, zero external assets (logo inlined as SVG data
 * URI, all CSS + JS inline). The only network call the page makes after load
 * is `new EventSource('/activity/stream?topics=tips,rooms,seeder,matches')` to
 * the same origin. Renders on hotel WiFi captive portals that strip CDNs.
 *
 * Caching: HTML cached 30s by lang, JSON cached 5s. Per-route rate limit
 * 30/min/IP. Both endpoints set Cache-Control public headers.
 *
 * Security:
 *  - All event payloads are PII-redacted at publish time (eventBus payloads;
 *    SECURITY_AUDIT HIGH-04). We re-apply escapeHtml in the HTML template and
 *    JSON.stringify-then-escape the hydration seed to block </script> breakout.
 *  - Ardoino quote text and team names route through escapeHtml.
 *  - No POST surface. Read-only.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { prismaQuery } from '../lib/prisma.ts';
import { eventBus } from '../lib/activity/eventBus.ts';
import { seederSupervisor } from '../lib/pears/seeder.ts';
import { TtlCache } from '../lib/cache.ts';
import { handleServerError } from '../utils/errorHandler.ts';
import { t, isSupportedLang, type Lang } from '../lib/i18n/index.ts';
import { getAllConfiguredChains } from '../lib/evm/chains.ts';
import { getProviderHealth } from '../lib/evm/provider.ts';
import { Prisma } from '../../prisma/generated/client.js';
import {
  DASHBOARD_HTML_CACHE_TTL_MS,
  DASHBOARD_JSON_CACHE_TTL_MS,
  DASHBOARD_RATE_LIMIT_MAX,
  DASHBOARD_RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';

// =============================================================================
// HTML escaping (defense in depth — payloads are already PII-redacted but team
// names + slugs + quote text reach here from user-influenced sources).
// =============================================================================

const escapeHtml = (s: unknown): string => {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// Encode an object as a JSON string that is safe to embed inside <script>.
// Escapes `<` so a `</script>` substring in any string cannot terminate the
// surrounding script block. Also escapes `&` and line terminators that some
// browsers treat as in-script directives.
const safeJsonForScript = (obj: unknown): string => {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
};

// =============================================================================
// Phrasebook — Ardoino quote of the day (deterministic by day-of-year).
// =============================================================================

interface PhrasebookQuote {
  id: string;
  text: string;
  speaker: string;
}
interface Phrasebook {
  quotes: PhrasebookQuote[];
}
let cachedPhrasebook: Phrasebook | null = null;
const loadPhrasebook = (): Phrasebook => {
  if (cachedPhrasebook) return cachedPhrasebook;
  try {
    const txt = readFileSync(
      resolve(process.cwd(), 'src/data/phrasebook.json'),
      'utf8'
    );
    cachedPhrasebook = JSON.parse(txt) as Phrasebook;
  } catch {
    cachedPhrasebook = { quotes: [] };
  }
  return cachedPhrasebook;
};

const pickQuoteOfDay = (): { text: string; speaker: string } | null => {
  const pb = loadPhrasebook();
  if (!pb.quotes.length) return null;
  const dayIndex = Math.floor(Date.now() / 86_400_000);
  const q = pb.quotes[dayIndex % pb.quotes.length];
  if (!q) return null;
  return { text: q.text, speaker: q.speaker };
};

// Test-only: blow away the phrasebook cache so a test can swap in a fixture
// (e.g. a malicious quote to verify HTML escaping). Production code MUST NOT
// call this.
export const __resetDashboardCachesForTest = (): void => {
  cachedPhrasebook = null;
  htmlCache.clear();
  jsonCache.clear();
};

// =============================================================================
// Live match detection. A match is "live" if status='live' OR its kickoff
// falls inside the live window (kickoff - 5 min .. kickoff + 140 min). The
// pulse worker keeps `status` accurate when running, but we OR with the time
// window so the dashboard still shows live matches when the worker is offline
// (graceful degradation per Section 20 F8 failure-modes table).
// =============================================================================

const LIVE_WINDOW_BEFORE_MS = 5 * 60_000;
const LIVE_WINDOW_AFTER_MS = 140 * 60_000;

interface LiveMatchRow {
  matchId: string;
  externalId: number | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  currentMinute: number | null;
  status: string;
  statusLabel: string;
  kickoffUtc: string;
}

// =============================================================================
// Dashboard data assembly
// =============================================================================

interface DashboardCounters {
  activeRooms: number;
  activePeers: number;
  tipsLifetimeUsdt: string;
  tipsLifetimeFormatted: string;
  tipsLifetimeCount: number;
  matchesLiveNow: number;
}

interface DashboardChain {
  chainId: number;
  name: string;
  enabled: boolean;
  healthy: boolean | null;
}

interface DashboardEvent {
  id: string;
  type: string;
  ts: string;
  summary: string;
  payload: unknown;
}

interface DashboardData {
  generatedAt: string;
  counters: DashboardCounters;
  liveMatches: LiveMatchRow[];
  recentEvents: DashboardEvent[];
  chains: DashboardChain[];
  ardoinoQuote: { text: string; speaker: string } | null;
  lang: Lang;
}

// Best-effort one-line summary for an eventBus event. Mirrors statusRoutes
// summariser plus the F7 match.* types.
const summarizeEvent = (ev: { type: string; payload: unknown }, lang: Lang): string => {
  const p = (ev.payload as Record<string, unknown>) ?? {};
  switch (ev.type) {
    case 'tip.confirmed': {
      const amt = String(p.amountFormatted ?? '');
      const to = String(p.toAddress ?? '');
      const room = p.roomSlug ? ` (${String(p.roomSlug)})` : '';
      return `${amt} USDT -> ${to}${room}`;
    }
    case 'room.created':
      return `room ${String(p.slug ?? '')} created`;
    case 'room.deleted':
      return `room ${String(p.slug ?? '')} deleted (${String(p.reason ?? '')})`;
    case 'seeder.peers_changed':
      return `${String(p.slug ?? '')} peers=${String(p.peerCount ?? '')}`;
    case 'match.starting_soon':
      return `match ${String(p.matchId ?? '')} starting in ${String(p.minutesUntilKickoff ?? '')}m`;
    case 'match.kickoff':
      return `${t('live.kickoff', lang)}: ${String(p.homeTeam ?? '')} vs ${String(p.awayTeam ?? '')}`;
    case 'match.goal': {
      const team = p.team === 'home' ? 'home' : 'away';
      const score = p.newScore as { home?: number; away?: number } | undefined;
      const scoreStr = score ? `${score.home ?? 0}-${score.away ?? 0}` : '';
      const minute = p.minute != null ? ` ${String(p.minute)}'` : '';
      return `${t('live.goal', lang)} ${team} ${scoreStr}${minute}`;
    }
    case 'match.score_changed': {
      const cur = p.current as { home?: number; away?: number } | undefined;
      return cur ? `score ${cur.home ?? 0}-${cur.away ?? 0}` : 'score changed';
    }
    case 'match.halftime':
      return t('live.halftime', lang);
    case 'match.fulltime':
      return t('live.fulltime', lang);
    default:
      return ev.type;
  }
};

const gatherDashboardData = async (lang: Lang): Promise<DashboardData> => {
  const now = new Date();
  const liveWindowStart = new Date(now.getTime() - LIVE_WINDOW_AFTER_MS);
  const liveWindowEnd = new Date(now.getTime() + LIVE_WINDOW_BEFORE_MS);

  // Counters — every aggregate independently catches its own failure so a
  // dead DB pings the page with `0` everywhere rather than 500ing.
  let activeRooms = 0;
  let lifetimeTipsCount = 0;
  let lifetimeTipsUsdt = '0';
  let liveMatchesRaw: Array<{
    id: string;
    externalId: number | null;
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    currentMinute: number | null;
    kickoffUtc: Date;
    homeTeam: { name: string } | null;
    awayTeam: { name: string } | null;
  }> = [];

  try {
    const [ar, tipsCount, tipsSumRows, liveMatches] = await Promise.all([
      prismaQuery.room
        .count({ where: { deletedAt: null, expiresAt: { gt: now }, isDemo: false } })
        .catch(() => 0),
      prismaQuery.tipEvent.count({ where: { isDemo: false } }).catch(() => 0),
      prismaQuery
        .$queryRaw<{ total: string | null }[]>(
          Prisma.sql`SELECT COALESCE(SUM(amount::numeric), 0)::text AS total FROM tip_events WHERE is_demo = false`
        )
        .catch(() => [{ total: '0' }]),
      // Live matches: anything currently inside the live window OR explicitly
      // marked status='live'. Limit 5 because the dashboard cards are sized for
      // ~5 simultaneous fixtures (matches the per-tick fan-out in F7).
      prismaQuery.match
        .findMany({
          where: {
            OR: [
              { status: 'live' },
              {
                kickoffUtc: { gte: liveWindowStart, lte: liveWindowEnd },
                status: { in: ['scheduled', 'live'] },
              },
            ],
          },
          orderBy: { kickoffUtc: 'asc' },
          take: 5,
          select: {
            id: true,
            externalId: true,
            status: true,
            homeScore: true,
            awayScore: true,
            currentMinute: true,
            kickoffUtc: true,
            homeTeam: { select: { name: true } },
            awayTeam: { select: { name: true } },
          },
        })
        .catch(() => []),
    ]);
    activeRooms = ar;
    lifetimeTipsCount = tipsCount;
    lifetimeTipsUsdt = tipsSumRows?.[0]?.total ?? '0';
    liveMatchesRaw = liveMatches;
  } catch {
    /* keep zeros */
  }

  // Format the lifetime tip total for display. formatUsdt expects a base-units
  // (6-decimal) string; the raw SUM is already in base units.
  const lifetimeTipsFormatted = formatUsdtBaseUnits(lifetimeTipsUsdt);

  const liveMatches: LiveMatchRow[] = liveMatchesRaw.map((m) => ({
    matchId: m.id,
    externalId: m.externalId ?? null,
    homeTeam: m.homeTeam?.name ?? '?',
    awayTeam: m.awayTeam?.name ?? '?',
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    currentMinute: m.currentMinute,
    status: m.status,
    statusLabel: t(`matches.status.${m.status}`, lang),
    kickoffUtc: m.kickoffUtc.toISOString(),
  }));

  // Recent events from the in-memory ring buffer, newest first.
  const recentEventsRaw = eventBus.getRecent({ limit: 50 }).reverse();
  const recentEvents: DashboardEvent[] = recentEventsRaw.map((e) => ({
    id: e.id,
    type: e.type,
    ts: new Date(e.ts).toISOString(),
    summary: summarizeEvent(e, lang),
    payload: e.payload,
  }));

  // Chains rollup — small, neutral. Disabled chains expose null healthy.
  const chains: DashboardChain[] = [];
  try {
    for (const c of getAllConfiguredChains()) {
      if (!c.enabled) {
        chains.push({ chainId: c.chainId, name: c.name, enabled: false, healthy: null });
        continue;
      }
      const h = getProviderHealth(c.chainId);
      chains.push({
        chainId: c.chainId,
        name: c.name,
        enabled: true,
        healthy: h.lagSeconds === null ? null : h.healthy,
      });
    }
  } catch {
    /* never let the chains rollup crash the dashboard */
  }

  const counters: DashboardCounters = {
    activeRooms,
    activePeers: seederSupervisor.getTotalPeers(),
    tipsLifetimeUsdt: lifetimeTipsUsdt,
    tipsLifetimeFormatted: lifetimeTipsFormatted,
    tipsLifetimeCount: lifetimeTipsCount,
    matchesLiveNow: liveMatches.length,
  };

  return {
    generatedAt: now.toISOString(),
    counters,
    liveMatches,
    recentEvents,
    chains,
    ardoinoQuote: pickQuoteOfDay(),
    lang,
  };
};

// Local copy of formatUsdt that handles the COALESCE(SUM(...)) numeric output
// shape. The SUM may return scientific notation or include a trailing '.0' on
// some Postgres versions, so we normalise to an integer string first.
const formatUsdtBaseUnits = (raw: string): string => {
  // Strip any decimal portion (the column itself is stored as a base-unit
  // integer; SUM(numeric) returns a numeric scalar that pg serialises with no
  // decimal when all inputs are integers, but we belt-and-brace).
  const cleaned = raw.split('.')[0] ?? '0';
  // Reject negatives + non-digits silently — they cannot happen with valid
  // tipEvent rows but we don't want a malformed value to throw on BigInt().
  if (!/^-?\d+$/.test(cleaned)) return '0.000000';
  try {
    const bi = BigInt(cleaned);
    const negative = bi < 0n;
    const abs = negative ? -bi : bi;
    const s = abs.toString().padStart(7, '0');
    const intPart = s.slice(0, -6);
    const fracPart = s.slice(-6);
    return `${negative ? '-' : ''}${intPart}.${fracPart}`;
  } catch {
    return '0.000000';
  }
};

// =============================================================================
// Curva logo (inline SVG, data-URI-friendly). Self-contained per ADR-008.
// Two-color mark: red + green Curva accent on a transparent background.
// =============================================================================

const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true">' +
  '<defs><linearGradient id="cg" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#ff5470"/><stop offset="1" stop-color="#1aff8c"/>' +
  '</linearGradient></defs>' +
  '<rect x="2" y="2" width="28" height="28" rx="6" fill="url(#cg)"/>' +
  '<text x="16" y="21" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="14" fill="#0a0a0a">C</text>' +
  '</svg>';

// =============================================================================
// HTML renderer
// =============================================================================

const renderHtml = (data: DashboardData): string => {
  const lang = data.lang;
  const title = t('dashboard.title', lang);
  const labels = {
    liveMatches: t('dashboard.live_matches', lang),
    activityFeed: t('dashboard.activity_feed', lang),
    activeRooms: t('dashboard.active_rooms', lang),
    activePeers: t('dashboard.active_peers', lang),
    lifetimeTips: t('dashboard.lifetime_tips', lang),
    tipsCount: t('dashboard.tips_count', lang),
    liveNow: t('dashboard.live_now', lang),
    disconnected: t('dashboard.disconnected', lang),
    enableSound: t('dashboard.enable_sound', lang),
    chains: t('dashboard.chains', lang),
    forzaCurva: t('dashboard.forza_curva', lang),
    noEvents: t('dashboard.no_events', lang),
    noMatches: t('dashboard.no_matches', lang),
    goal: t('live.goal', lang),
    halftime: t('live.halftime', lang),
    fulltime: t('live.fulltime', lang),
    kickoff: t('live.kickoff', lang),
  };

  // Hydration seed — JSON.stringify with </script> breakout protection.
  const seedJson = safeJsonForScript({ data, labels });

  const matchCard = (m: LiveMatchRow): string => {
    const home = escapeHtml(m.homeTeam);
    const away = escapeHtml(m.awayTeam);
    const hs = m.homeScore ?? 0;
    const as = m.awayScore ?? 0;
    const minute = m.currentMinute != null ? `${m.currentMinute}'` : escapeHtml(m.statusLabel);
    return `<div class="match" data-mid="${escapeHtml(m.matchId)}">
      <div class="match-teams">${home} <span class="vs">vs</span> ${away}</div>
      <div class="match-score"><span class="hs">${hs}</span>-<span class="as">${as}</span></div>
      <div class="match-min">${escapeHtml(minute)}</div>
    </div>`;
  };

  const eventRow = (e: DashboardEvent): string => {
    return `<li data-eid="${escapeHtml(e.id)}"><span class="etype">${escapeHtml(e.type)}</span> <span class="esum">${escapeHtml(e.summary)}</span></li>`;
  };

  const chainPill = (c: DashboardChain): string => {
    const color =
      c.healthy === true ? '#1aff8c' : c.healthy === false ? '#ff5470' : '#8aa1b8';
    const dot = `<span class="dot" style="background:${color}"></span>`;
    return `<span class="chain">${dot}${escapeHtml(c.name)}${c.enabled ? '' : ' (off)'}</span>`;
  };

  const quote = data.ardoinoQuote;

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #0a0a0a; color: #d8e0e8; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; min-height: 100vh; }
  a { color: #1aff8c; text-decoration: none; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid #1f2733; background: #0c1117; position: sticky; top: 0; z-index: 5; }
  header .logo { width: 28px; height: 28px; }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; }
  header .lang { margin-left: auto; font-size: 12px; color: #8aa1b8; }
  header .lang a { margin-left: 8px; color: #8aa1b8; }
  header .lang a.active { color: #1aff8c; font-weight: 600; }
  .counters { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; padding: 14px 20px; }
  .card { background: #131a23; border: 1px solid #1f2733; border-radius: 8px; padding: 12px 14px; transition: background 0.6s ease, border-color 0.6s ease; }
  .card.pulse { background: #1b2733; border-color: #1aff8c; }
  .card .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #8aa1b8; }
  .card .value { font-size: 22px; font-weight: 700; margin-top: 6px; font-variant-numeric: tabular-nums; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 0 20px 20px; }
  @media (max-width: 720px) { main { grid-template-columns: 1fr; } }
  section { background: #0c1117; border: 1px solid #1f2733; border-radius: 8px; padding: 14px; }
  section h2 { margin: 0 0 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #8aa1b8; }
  .match { background: #131a23; border: 1px solid #1f2733; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; }
  .match-teams { font-size: 14px; font-weight: 600; }
  .match .vs { color: #8aa1b8; font-weight: 400; margin: 0 4px; }
  .match-score { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; color: #1aff8c; }
  .match-min { font-size: 12px; color: #8aa1b8; text-align: right; min-width: 40px; }
  .empty { color: #8aa1b8; font-style: italic; font-size: 13px; padding: 4px 0; }
  ul.feed { list-style: none; margin: 0; padding: 0; max-height: 480px; overflow-y: auto; }
  ul.feed li { padding: 6px 0; border-bottom: 1px dashed #1f2733; font-size: 13px; color: #b0bcc8; }
  ul.feed li.new { background: linear-gradient(90deg, #1aff8c11, transparent); }
  .etype { color: #8aa1b8; font-family: ui-monospace, "SF Mono", monospace; font-size: 11px; margin-right: 8px; }
  footer { padding: 14px 20px 28px; border-top: 1px solid #1f2733; font-size: 12px; color: #8aa1b8; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  footer .quote { font-style: italic; color: #d8e0e8; flex: 1 1 320px; min-width: 0; }
  footer .forza { color: #ff5470; font-weight: 700; }
  footer .chain { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
  /* Disconnected banner */
  #banner { display: none; position: fixed; top: 0; left: 0; right: 0; padding: 8px 16px; background: #ffd16622; color: #ffd166; text-align: center; font-size: 13px; z-index: 10; border-bottom: 1px solid #ffd16644; }
  #banner.on { display: block; }
  /* Goal flash overlay */
  #goal-flash { display: none; position: fixed; inset: 0; background: radial-gradient(ellipse at center, #1aff8c, #0a0a0a); color: #0a0a0a; align-items: center; justify-content: center; flex-direction: column; z-index: 99; animation: goalFlash 2s ease-out; }
  #goal-flash.on { display: flex; }
  #goal-flash .label { font-size: 96px; font-weight: 900; letter-spacing: 0.05em; text-shadow: 0 4px 24px #0008; }
  #goal-flash .who { font-size: 24px; font-weight: 700; margin-top: 8px; color: #0a0a0a; }
  @keyframes goalFlash {
    0%   { opacity: 0; transform: scale(0.8); }
    20%  { opacity: 1; transform: scale(1.05); }
    80%  { opacity: 1; transform: scale(1); }
    100% { opacity: 0; transform: scale(1); }
  }
  #sound-btn { position: fixed; bottom: 16px; right: 16px; background: #131a23; color: #1aff8c; border: 1px solid #1aff8c; border-radius: 999px; padding: 8px 14px; font-size: 12px; cursor: pointer; display: none; z-index: 6; }
  #sound-btn.on { display: inline-block; }
</style>
</head>
<body>
  <div id="banner">${escapeHtml(labels.disconnected)}</div>
  <div id="goal-flash" role="alert" aria-live="assertive">
    <div class="label" id="goal-label">${escapeHtml(labels.goal)}</div>
    <div class="who" id="goal-who"></div>
  </div>
  <header>
    <img class="logo" alt="Curva" src="data:image/svg+xml;utf8,${encodeURIComponent(LOGO_SVG)}"/>
    <h1>${escapeHtml(title)}</h1>
    <span class="lang">
      <a href="/dashboard?lang=en" class="${lang === 'en' ? 'active' : ''}">en</a>
      <a href="/dashboard?lang=it" class="${lang === 'it' ? 'active' : ''}">it</a>
      <a href="/dashboard?lang=id" class="${lang === 'id' ? 'active' : ''}">id</a>
    </span>
  </header>

  <div class="counters">
    <div class="card" id="c-rooms"><div class="label">${escapeHtml(labels.activeRooms)}</div><div class="value" id="v-rooms">${data.counters.activeRooms}</div></div>
    <div class="card" id="c-peers"><div class="label">${escapeHtml(labels.activePeers)}</div><div class="value" id="v-peers">${data.counters.activePeers}</div></div>
    <div class="card" id="c-tips"><div class="label">${escapeHtml(labels.lifetimeTips)}</div><div class="value" id="v-tips">${escapeHtml(data.counters.tipsLifetimeFormatted)} USDT</div></div>
    <div class="card" id="c-tipsn"><div class="label">${escapeHtml(labels.tipsCount)}</div><div class="value" id="v-tipsn">${data.counters.tipsLifetimeCount}</div></div>
    <div class="card" id="c-live"><div class="label">${escapeHtml(labels.liveNow)}</div><div class="value" id="v-live">${data.counters.matchesLiveNow}</div></div>
  </div>

  <main>
    <section>
      <h2>${escapeHtml(labels.liveMatches)}</h2>
      <div id="matches">
        ${
          data.liveMatches.length === 0
            ? `<div class="empty">${escapeHtml(labels.noMatches)}</div>`
            : data.liveMatches.map(matchCard).join('')
        }
      </div>
    </section>
    <section>
      <h2>${escapeHtml(labels.activityFeed)}</h2>
      <ul class="feed" id="feed">
        ${
          data.recentEvents.length === 0
            ? `<li class="empty">${escapeHtml(labels.noEvents)}</li>`
            : data.recentEvents.map(eventRow).join('')
        }
      </ul>
    </section>
  </main>

  <footer>
    <span>${escapeHtml(labels.chains)}: ${data.chains.map(chainPill).join(' ')}</span>
    ${
      quote
        ? `<span class="quote">"${escapeHtml(quote.text)}" — ${escapeHtml(quote.speaker)}</span>`
        : ''
    }
    <span class="forza">${escapeHtml(labels.forzaCurva)}</span>
  </footer>

  <button id="sound-btn" type="button">${escapeHtml(labels.enableSound)}</button>

  <script>window.__CURVA__ = ${seedJson};</script>
  <script>${INLINE_JS}</script>
</body>
</html>`;
};

// =============================================================================
// Inline JS. Kept as a single string constant so the renderer can reuse it
// across cache hits without re-concatenating. ~180 lines, no frameworks.
// =============================================================================

const INLINE_JS = `(function(){
  var seed = window.__CURVA__ || {data:{recentEvents:[],liveMatches:[],counters:{}},labels:{}};
  var state = {
    counters: Object.assign({activeRooms:0,activePeers:0,tipsLifetimeUsdt:'0',tipsLifetimeFormatted:'0.000000',tipsLifetimeCount:0,matchesLiveNow:0}, seed.data.counters || {}),
    matches: (seed.data.liveMatches || []).reduce(function(m,x){m[x.matchId]=x;return m;},{}),
    feedIds: new Set((seed.data.recentEvents || []).map(function(e){return e.id;}))
  };
  var labels = seed.labels || {};
  var FEED_CAP = 50;

  function $(id){ return document.getElementById(id); }
  function escapeHtml(s){
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function pulse(id){
    var el = $(id); if (!el) return;
    el.classList.add('pulse');
    setTimeout(function(){ el.classList.remove('pulse'); }, 700);
  }
  function setCounter(id, val){
    var el = $(id); if (!el) return;
    el.textContent = val;
  }
  function bumpInt(key, elId, delta){
    state.counters[key] = (state.counters[key] || 0) + delta;
    setCounter(elId, state.counters[key]);
  }
  function addTip(payload){
    // Tally + format. We don't have native BigInt support guaranteed in every
    // browser (it is widely available but not in legacy IE/Safari); we treat
    // the running total as a string and fall back to the server-rendered
    // value on overflow.
    try {
      var addUnits = BigInt(payload.amount || '0');
      var prev = BigInt(state.counters.tipsLifetimeUsdt || '0');
      var next = prev + addUnits;
      state.counters.tipsLifetimeUsdt = next.toString();
      var s = next.toString().padStart(7, '0');
      var fmt = s.slice(0, -6) + '.' + s.slice(-6);
      state.counters.tipsLifetimeFormatted = fmt;
      setCounter('v-tips', fmt + ' USDT');
    } catch (e) {
      // BigInt unavailable; leave the displayed value as-is.
    }
    state.counters.tipsLifetimeCount += 1;
    setCounter('v-tipsn', state.counters.tipsLifetimeCount);
    pulse('c-tips'); pulse('c-tipsn');
  }
  function prependEvent(ev){
    if (state.feedIds.has(ev.id)) return;
    state.feedIds.add(ev.id);
    var feed = $('feed'); if (!feed) return;
    // Drop "no events" placeholder if present.
    var first = feed.firstElementChild;
    if (first && first.classList.contains('empty')) feed.removeChild(first);
    var li = document.createElement('li');
    li.className = 'new';
    li.setAttribute('data-eid', ev.id);
    var span1 = document.createElement('span'); span1.className = 'etype'; span1.textContent = ev.type;
    var span2 = document.createElement('span'); span2.className = 'esum'; span2.textContent = ev.summary;
    li.appendChild(span1); li.appendChild(document.createTextNode(' ')); li.appendChild(span2);
    feed.insertBefore(li, feed.firstChild);
    while (feed.children.length > FEED_CAP) feed.removeChild(feed.lastChild);
    setTimeout(function(){ li.classList.remove('new'); }, 1500);
  }
  function updateMatchCard(matchId, mut){
    var card = document.querySelector('[data-mid="' + CSS.escape(matchId) + '"]');
    if (!card) return;
    if (mut.score) {
      var hs = card.querySelector('.hs'); var as = card.querySelector('.as');
      if (hs) hs.textContent = mut.score.home;
      if (as) as.textContent = mut.score.away;
    }
    if (mut.minute != null) {
      var m = card.querySelector('.match-min');
      if (m) m.textContent = mut.minute + "'";
    }
  }
  function summarizeFallback(ev){
    var p = ev.payload || {};
    switch (ev.type) {
      case 'tip.confirmed':
        return (p.amountFormatted || '') + ' USDT -> ' + (p.toAddress || '') + (p.roomSlug ? ' (' + p.roomSlug + ')' : '');
      case 'room.created': return 'room ' + (p.slug || '') + ' created';
      case 'room.deleted': return 'room ' + (p.slug || '') + ' deleted (' + (p.reason || '') + ')';
      case 'seeder.peers_changed': return (p.slug || '') + ' peers=' + (p.peerCount || 0);
      case 'match.kickoff': return (labels.kickoff || 'Kick-off') + ': ' + (p.homeTeam || '') + ' vs ' + (p.awayTeam || '');
      case 'match.goal': {
        var sc = p.newScore || {}; var mn = p.minute != null ? ' ' + p.minute + "'" : '';
        return (labels.goal || 'GOAL') + ' ' + (p.team || '') + ' ' + (sc.home || 0) + '-' + (sc.away || 0) + mn;
      }
      case 'match.score_changed': {
        var c = p.current || {}; return 'score ' + (c.home || 0) + '-' + (c.away || 0);
      }
      case 'match.halftime': return labels.halftime || 'Half-time';
      case 'match.fulltime': return labels.fulltime || 'Full-time';
      default: return ev.type;
    }
  }

  // --- Audio beep ---------------------------------------------------------
  var audioCtx = null;
  var audioBlocked = false;
  function initAudio() {
    if (audioCtx) return audioCtx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { audioBlocked = true; return null; }
      audioCtx = new AC();
    } catch (e) { audioBlocked = true; }
    return audioCtx;
  }
  function beep() {
    var ctx = initAudio(); if (!ctx) return;
    // Autoplay policy: if suspended, surface the enable-sound button instead.
    if (ctx.state === 'suspended') {
      var btn = $('sound-btn'); if (btn) btn.classList.add('on');
      return;
    }
    try {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = 880;
      gain.gain.value = 0.0001;
      gain.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.22);
    } catch (e) { /* ignore */ }
  }
  var soundBtn = $('sound-btn');
  if (soundBtn) {
    soundBtn.addEventListener('click', function(){
      var ctx = initAudio();
      if (ctx && ctx.resume) ctx.resume();
      soundBtn.classList.remove('on');
    });
  }

  // --- Goal flash ---------------------------------------------------------
  function goalFlash(payload) {
    var overlay = $('goal-flash'); if (!overlay) return;
    var who = $('goal-who');
    if (who) {
      var sc = payload.newScore || {};
      var team = payload.team === 'home' ? 'HOME' : 'AWAY';
      var minute = payload.minute != null ? " " + payload.minute + "'" : '';
      who.textContent = team + ' ' + (sc.home || 0) + '-' + (sc.away || 0) + minute;
    }
    overlay.classList.add('on');
    beep();
    setTimeout(function(){ overlay.classList.remove('on'); }, 2000);
  }

  // --- Event dispatch -----------------------------------------------------
  function onEvent(ev) {
    if (!ev || !ev.type) return;
    // Re-summarise client-side so the localisation matches the page lang.
    if (!ev.summary) ev.summary = summarizeFallback(ev);
    switch (ev.type) {
      case 'tip.confirmed':
        prependEvent(ev); addTip(ev.payload || {}); break;
      case 'tip.pending':
        prependEvent(ev); break;
      case 'room.created':
        prependEvent(ev); bumpInt('activeRooms', 'v-rooms', 1); pulse('c-rooms'); break;
      case 'room.deleted':
        prependEvent(ev); bumpInt('activeRooms', 'v-rooms', -1); break;
      case 'seeder.peers_changed': {
        // No feed entry — peer churn is too chatty. Just track totals if room visible.
        var p = ev.payload || {};
        if (typeof p.peerCount === 'number') { /* no aggregate update; counters poll separately */ }
        break;
      }
      case 'match.kickoff':
        prependEvent(ev); break;
      case 'match.goal':
        prependEvent(ev);
        var p = ev.payload || {};
        if (p.newScore) updateMatchCard(p.matchId, { score: p.newScore, minute: p.minute });
        goalFlash(p);
        break;
      case 'match.score_changed': {
        var p2 = ev.payload || {};
        if (p2.current) updateMatchCard(p2.matchId, { score: p2.current });
        break;
      }
      case 'match.halftime':
      case 'match.fulltime':
        prependEvent(ev); break;
      default:
        prependEvent(ev);
    }
  }

  // --- EventSource with exponential backoff -------------------------------
  var es = null; var backoff = 1000; var reconnectTimer = null;
  function clearBanner(){ var b = $('banner'); if (b) b.classList.remove('on'); }
  function showBanner(){ var b = $('banner'); if (b) b.classList.add('on'); }
  function connect() {
    if (es) { try { es.close(); } catch(e){} es = null; }
    try {
      es = new EventSource('/activity/stream?topics=tips,rooms,seeder,matches');
    } catch (e) {
      scheduleReconnect(); return;
    }
    es.onopen = function(){ clearBanner(); backoff = 1000; };
    es.onmessage = function(msg){
      try { onEvent(JSON.parse(msg.data)); } catch (e) {}
    };
    // Named events: SSE 'event: match.goal' lines come through dedicated handlers.
    // We register the same dispatcher for known types so the data: payload routes.
    var TYPES = ['tip.confirmed','tip.pending','room.created','room.deleted','seeder.peers_changed','match.kickoff','match.goal','match.score_changed','match.halftime','match.fulltime','match.starting_soon'];
    TYPES.forEach(function(tn){
      es.addEventListener(tn, function(msg){
        try { onEvent(JSON.parse(msg.data)); } catch (e) {}
      });
    });
    es.onerror = function(){
      // The browser auto-reconnects per the SSE 'retry:' header, but the spec
      // closes the EventSource on certain HTTP errors. Always show the banner
      // and schedule our own reconnect as a backstop.
      showBanner();
      if (es && es.readyState === 2) scheduleReconnect();
    };
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function(){
      reconnectTimer = null;
      backoff = Math.min(backoff * 2, 30000);
      connect();
    }, backoff);
  }
  connect();
})();`;

// =============================================================================
// Route plugin. Two routes, both at root scope so the prefix-less registration
// in index.ts yields the desired `/dashboard` + `/dashboard.json` URLs.
// =============================================================================

const htmlCache = new TtlCache<string>(8); // {lang} keys + headroom
const jsonCache = new TtlCache<DashboardData>(4);

export const dashboardRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  // GET /dashboard — HTML
  app.get(
    '/dashboard',
    {
      config: {
        rateLimit: {
          max: DASHBOARD_RATE_LIMIT_MAX,
          timeWindow: DASHBOARD_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const q = (request.query || {}) as Record<string, unknown>;
        const lang: Lang = isSupportedLang(q.lang)
          ? q.lang
          : isSupportedLang(request.lang)
          ? request.lang
          : 'en';
        const html = await htmlCache.memoize(
          `html:${lang}`,
          DASHBOARD_HTML_CACHE_TTL_MS,
          async () => {
            const data = await gatherDashboardData(lang);
            return renderHtml(data);
          }
        );
        reply.header('Content-Type', 'text/html; charset=utf-8');
        reply.header(
          'Cache-Control',
          `public, max-age=${Math.floor(DASHBOARD_HTML_CACHE_TTL_MS / 1000)}`
        );
        // Conservative referrer policy: judges may share screenshots; we don't
        // want the URL leaking via outbound clicks.
        reply.header('Referrer-Policy', 'no-referrer');
        reply.header('X-Content-Type-Options', 'nosniff');
        // Defense-in-depth headers (SECURITY_AUDIT.md W3-MED-01, ADR-008).
        // Inline scripts/styles are intentional per ADR-008 (zero build step)
        // so 'unsafe-inline' is required for both — but every other directive
        // is locked down. `connect-src 'self'` keeps the EventSource same-origin
        // even if a future template change inadvertently exposed a URL knob.
        // `frame-ancestors 'none'` plus the legacy `X-Frame-Options: DENY`
        // header neutralise clickjacking for public-URL screenshot scenarios.
        reply.header(
          'Content-Security-Policy',
          "script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'"
        );
        reply.header('X-Frame-Options', 'DENY');
        return reply.code(200).send(html);
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  // GET /dashboard.json — initial hydration state (the JS keeps it live via SSE)
  app.get(
    '/dashboard.json',
    {
      config: {
        rateLimit: {
          max: DASHBOARD_RATE_LIMIT_MAX,
          timeWindow: DASHBOARD_RATE_LIMIT_WINDOW,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const q = (request.query || {}) as Record<string, unknown>;
        const lang: Lang = isSupportedLang(q.lang)
          ? q.lang
          : isSupportedLang(request.lang)
          ? request.lang
          : 'en';
        const data = await jsonCache.memoize(
          `json:${lang}`,
          DASHBOARD_JSON_CACHE_TTL_MS,
          () => gatherDashboardData(lang)
        );
        reply.header(
          'Cache-Control',
          `public, max-age=${Math.floor(DASHBOARD_JSON_CACHE_TTL_MS / 1000)}`
        );
        // Match the HTML route's defense-in-depth headers
        // (SECURITY_AUDIT.md W3-MED-01).
        reply.header('X-Frame-Options', 'DENY');
        reply.header('Referrer-Policy', 'no-referrer');
        return reply.code(200).send({ success: true, error: null, data });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
