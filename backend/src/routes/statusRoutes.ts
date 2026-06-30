/**
 * Public status page (F4).
 *
 *   GET /status            — HTML, en/it via ?lang=
 *   GET /status.json       — JSON envelope with the same data
 *
 * Per ARCH 19 F4 + CURVA_TECHNICAL_SPEC Section 11 (third-party disclosure).
 *
 * Data sources: existing healthRoutes helpers (DB ping), seederSupervisor,
 * IndexerCursor, CatalogSync, Prisma counts, eventBus.getRecent.
 *
 * 5s cache keyed by lang. Rate limit 30/min/IP. Italian copy table inline.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { Prisma } from '../../prisma/generated/client.js';
import { prismaQuery } from '../lib/prisma.ts';
import { seederSupervisor } from '../lib/pears/seeder.ts';
import { eventBus } from '../lib/activity/eventBus.ts';
import { TtlCache } from '../lib/cache.ts';
import { handleServerError } from '../utils/errorHandler.ts';
import { t, isSupportedLang, type Lang } from '../lib/i18n/index.ts';
import { getAllConfiguredChains } from '../lib/evm/chains.ts';
import { getProviderHealth } from '../lib/evm/provider.ts';
import {
  FOOTBALL_DATA_API_KEY,
  FOOTBALL_DATA_COMPETITION,
  IS_PROD,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_RPC_URLS,
  SEPOLIA_USDT_ADDRESS,
  SERVICE_STARTED_AT,
  SERVICE_VERSION,
  STATUS_CACHE_TTL_MS,
  STATUS_RATE_LIMIT_MAX,
  STATUS_RATE_LIMIT_WINDOW,
} from '../config/main-config.ts';

// =============================================================================
// One-time read of package.json for the dependency version table.
// =============================================================================

interface PackageJson {
  dependencies?: Record<string, string>;
}

let cachedDeps: Record<string, string> | null = null;
const loadDepVersions = (): Record<string, string> => {
  if (cachedDeps) return cachedDeps;
  try {
    const txt = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const pkg = JSON.parse(txt) as PackageJson;
    cachedDeps = pkg.dependencies ?? {};
  } catch {
    cachedDeps = {};
  }
  return cachedDeps;
};

// =============================================================================
// Phrasebook for Ardoino footer quote
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

// Pick a quote deterministically per day so the page is stable for screenshots.
const pickQuoteOfDay = (): PhrasebookQuote | null => {
  const pb = loadPhrasebook();
  if (!pb.quotes.length) return null;
  const dayIndex = Math.floor(Date.now() / 86_400_000);
  return pb.quotes[dayIndex % pb.quotes.length] ?? null;
};

// =============================================================================
// Copy table — sourced entirely from src/data/translations/{lang}.json via the
// F9 i18n helper. The status page now supports en/it/id; adding a new language
// is a JSON-only change.
// =============================================================================

interface StatusCopy {
  title: string;
  lastUpdated: string;
  serviceHealth: string;
  liveMetrics: string;
  recentActivity: string;
  thirdParty: string;
  versions: string;
  forzaCurva: string;
  builtFor: string;
  ok: string;
  degraded: string;
  down: string;
  activeRooms: string;
  totalRooms: string;
  totalTipsLifetime: string;
  totalTipsToday: string;
  activePeers: string;
  api: string;
  db: string;
  seeder: string;
  indexer: string;
  catalog: string;
  noRecentEvents: string;
  // F10 chains section
  chainsTitle: string;
  chainHealthy: string;
  chainUnhealthy: string;
  chainUnknown: string;
}

const buildCopy = (lang: Lang): StatusCopy => ({
  title: t('status.title', lang),
  lastUpdated: t('status.last_updated', lang),
  serviceHealth: t('status.service_health', lang),
  liveMetrics: t('status.live_metrics', lang),
  recentActivity: t('status.recent_activity', lang),
  thirdParty: t('status.third_party', lang),
  versions: t('status.versions', lang),
  forzaCurva: t('status.forza_curva', lang),
  builtFor: t('status.built_for', lang),
  ok: t('status.ok', lang),
  degraded: t('status.degraded', lang),
  down: t('status.down', lang),
  activeRooms: t('status.active_rooms', lang),
  totalRooms: t('status.total_rooms', lang),
  totalTipsLifetime: t('status.total_tips_lifetime', lang),
  totalTipsToday: t('status.total_tips_today', lang),
  activePeers: t('status.active_peers', lang),
  api: t('status.api', lang),
  db: t('status.db', lang),
  seeder: t('status.seeder', lang),
  indexer: t('status.indexer', lang),
  catalog: t('status.catalog', lang),
  noRecentEvents: t('status.no_recent_events', lang),
  // F10 — chain rollup labels
  chainsTitle: t('status.chains', lang),
  chainHealthy: t('chains.health.healthy', lang),
  chainUnhealthy: t('chains.health.unhealthy', lang),
  chainUnknown: t('chains.health.unknown', lang),
});

// =============================================================================
// HTML escaping (defense in depth — most strings are server-controlled already
// but recentActivity payloads can carry slugs the user picked).
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

// =============================================================================
// URL truncation for the third-party disclosure list.
// =============================================================================

const truncateUrl = (u: string): string => {
  try {
    const parsed = new URL(u);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return u.split('?')[0]?.slice(0, 80) ?? '';
  }
};

// =============================================================================
// Status data assembly
// =============================================================================

interface StatusData {
  status: 'ok' | 'degraded' | 'down';
  generatedAt: string;
  uptimeSeconds: number;
  version: string;
  components: {
    api: { ok: boolean };
    db: { ok: boolean; latencyMs: number };
    seeder: { ok: boolean; enabled: boolean; activeRooms: number; totalPeers: number };
    indexer: { ok: boolean; lastBlock: number | null; lagSeconds: number | null };
    catalog: { ok: boolean; lastSyncAt: string | null; matchCount: number };
  };
  metrics: {
    activeRooms: number;
    totalRooms: number;
    totalTipsLifetime: number;
    totalTipsToday: number;
    totalAmountLifetime: string;
    activePeers: number;
  };
  recentEvents: Array<{ type: string; ts: string; summary: string }>;
  thirdPartyServices: Array<{ name: string; urls?: string[]; url?: string; enabled?: boolean; chainId?: number }>;
  versions: Record<string, string>;
  // F10: per-chain rollup. `healthy` is null when (a) the chain is disabled or
  // (b) we have not yet attempted a call (boot fence).
  chains: Array<{
    chainId: number;
    name: string;
    enabled: boolean;
    healthy: boolean | null;
    lastBlockNumber: number | null;
    lagSeconds: number | null;
    usdtAddress: string;
  }>;
}

const pingDb = async (): Promise<{ ok: boolean; latencyMs: number }> => {
  const start = Date.now();
  try {
    await prismaQuery.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
};

const summarizeEvent = (ev: { type: string; payload: unknown }): string => {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.type) {
    case 'tip.confirmed':
      return `${String(p?.amountFormatted ?? '')} USDT -> ${String(p?.toAddress ?? '')}${
        p?.roomSlug ? ` (${String(p.roomSlug)})` : ''
      }`;
    case 'room.created':
      return `room ${String(p?.slug ?? '')} created`;
    case 'room.deleted':
      return `room ${String(p?.slug ?? '')} deleted (${String(p?.reason ?? '')})`;
    case 'seeder.peers_changed':
      return `${String(p?.slug ?? '')} peers=${String(p?.peerCount ?? '')}`;
    case 'match.starting_soon':
      return `match ${String(p?.matchId ?? '')} starting in ${String(p?.minutesUntilKickoff ?? '')}m`;
    default:
      return ev.type;
  }
};

const buildStatusData = async (): Promise<StatusData> => {
  const now = new Date();
  // "Tips today" / "Mance oggi" anchors to UTC midnight so the label matches
  // the data. A rolling 24h window would say "today" but report yesterday's
  // late-night tips at 23:00 UTC. See CODE_REVIEW W2 Major #2.
  const todayStart = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0, 0, 0, 0
  ));
  const dbResult = await pingDb();

  let indexer = { ok: false, lastBlock: null as number | null, lagSeconds: null as number | null };
  let catalog = { ok: false, lastSyncAt: null as string | null, matchCount: 0 };
  let activeRooms = 0;
  let totalRooms = 0;
  let totalTipsLifetime = 0;
  let totalTipsToday = 0;
  let totalAmountLifetime = '0';

  if (dbResult.ok) {
    const [cursor, sync, matchCount, ar, tr, tipsTotal, tipsToday, lifetimeSum] = await Promise.all([
      prismaQuery.indexerCursor
        .findUnique({
          where: {
            chainId_tokenAddress: {
              chainId: SEPOLIA_CHAIN_ID,
              tokenAddress: SEPOLIA_USDT_ADDRESS,
            },
          },
        })
        .catch(() => null),
      prismaQuery.catalogSync.findFirst({ orderBy: { createdAt: 'desc' } }).catch(() => null),
      prismaQuery.match.count().catch(() => 0),
      prismaQuery.room
        .count({ where: { deletedAt: null, expiresAt: { gt: now }, isDemo: false } })
        .catch(() => 0),
      prismaQuery.room.count({ where: { isDemo: false } }).catch(() => 0),
      prismaQuery.tipEvent.count({ where: { isDemo: false } }).catch(() => 0),
      prismaQuery.tipEvent
        .count({ where: { blockTime: { gte: todayStart }, isDemo: false } })
        .catch(() => 0),
      // W2-HIGH-03: demo rows are excluded from every public counter surfaced
      // on /status.json. See healthRoutes.ts /metrics/live for the same policy
      // applied to the sibling metrics endpoint.
      prismaQuery
        .$queryRaw<{ total: string | null }[]>(
          Prisma.sql`SELECT COALESCE(SUM(amount::numeric), 0)::text AS total FROM tip_events WHERE is_demo = false`
        )
        .catch(() => [{ total: '0' }]),
    ]);

    indexer = {
      ok: !!cursor,
      lastBlock: cursor?.lastBlockNumber ?? null,
      lagSeconds: cursor?.updatedAt
        ? Math.floor((Date.now() - cursor.updatedAt.getTime()) / 1000)
        : null,
    };
    catalog = {
      ok: !!sync && sync.status === 'ok',
      lastSyncAt: sync?.createdAt.toISOString() ?? null,
      matchCount,
    };
    activeRooms = ar;
    totalRooms = tr;
    totalTipsLifetime = tipsTotal;
    totalTipsToday = tipsToday;
    totalAmountLifetime = lifetimeSum?.[0]?.total ?? '0';
  }

  const seederInfo = {
    ok: true,
    enabled: seederSupervisor.isEnabled(),
    activeRooms: seederSupervisor.getActiveRoomCount(),
    totalPeers: seederSupervisor.getTotalPeers(),
  };

  const overallStatus: StatusData['status'] = !dbResult.ok
    ? 'down'
    : !catalog.ok || !indexer.ok
    ? 'degraded'
    : 'ok';

  const recentEvents = eventBus
    .getRecent({ limit: 20 })
    .reverse() // newest first
    .map((e) => ({
      type: e.type,
      ts: new Date(e.ts).toISOString(),
      summary: summarizeEvent(e),
    }));

  const deps = loadDepVersions();
  const versions: Record<string, string> = {
    service: SERVICE_VERSION,
    bun: process.versions.bun ?? 'n/a',
    node: process.versions.node,
    fastify: deps['fastify'] ?? 'n/a',
    'fastify-cors': deps['@fastify/cors'] ?? 'n/a',
    'fastify-rate-limit': deps['@fastify/rate-limit'] ?? 'n/a',
    prisma: deps['@prisma/client'] ?? 'n/a',
    ethers: deps['ethers'] ?? 'n/a',
    'node-cron': deps['node-cron'] ?? 'n/a',
  };

  const thirdPartyServices: StatusData['thirdPartyServices'] = [
    {
      name: 'Sepolia RPC',
      urls: SEPOLIA_RPC_URLS.map((u) => truncateUrl(u)),
      chainId: SEPOLIA_CHAIN_ID,
    },
    {
      name: 'football-data.org',
      enabled: Boolean(FOOTBALL_DATA_API_KEY),
      url: `https://api.football-data.org/v4/competitions/${FOOTBALL_DATA_COMPETITION}`,
    },
    {
      name: 'Hyperswarm DHT',
      enabled: seederSupervisor.isEnabled(),
    },
  ];

  // F10: assemble per-chain rollup. Disabled chains expose null health so the
  // UI can render a neutral "Unknown" badge rather than asserting either way.
  const chainsRollup: StatusData['chains'] = [];
  try {
    for (const c of getAllConfiguredChains()) {
      if (!c.enabled) {
        chainsRollup.push({
          chainId: c.chainId,
          name: c.name,
          enabled: false,
          healthy: null,
          lastBlockNumber: null,
          lagSeconds: null,
          usdtAddress: c.usdtAddress,
        });
        continue;
      }
      const h = getProviderHealth(c.chainId);
      chainsRollup.push({
        chainId: c.chainId,
        name: c.name,
        enabled: true,
        healthy: h.lagSeconds === null ? null : h.healthy,
        lastBlockNumber: h.lastBlockNumber,
        lagSeconds: h.lagSeconds,
        usdtAddress: c.usdtAddress,
      });
    }
  } catch {
    /* never let the chains rollup crash the status page */
  }

  return {
    status: overallStatus,
    generatedAt: now.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - SERVICE_STARTED_AT) / 1000),
    version: SERVICE_VERSION,
    components: {
      api: { ok: true },
      db: dbResult,
      seeder: seederInfo,
      indexer,
      catalog,
    },
    chains: chainsRollup,
    metrics: {
      activeRooms,
      totalRooms,
      totalTipsLifetime,
      totalTipsToday,
      totalAmountLifetime,
      activePeers: seederInfo.totalPeers,
    },
    recentEvents,
    thirdPartyServices,
    versions,
  };
};

// =============================================================================
// HTML renderer
// =============================================================================

const renderHtml = (data: StatusData, lang: Lang): string => {
  const c = buildCopy(lang);
  const quote = pickQuoteOfDay();

  const statusColor =
    data.status === 'ok' ? '#1aff8c' : data.status === 'degraded' ? '#ffd166' : '#ff5470';
  const statusLabel = c[data.status];

  const componentRow = (name: string, ok: boolean, detail = ''): string =>
    `<tr><td>${escapeHtml(name)}</td><td><span class="dot" style="background:${ok ? '#1aff8c' : '#ff5470'}"></span>${ok ? c.ok : c.down}</td><td>${escapeHtml(detail)}</td></tr>`;

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(c.title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #0c1117; color: #d8e0e8; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
  header { display: flex; align-items: center; gap: 16px; border-bottom: 1px solid #1f2733; padding-bottom: 16px; }
  header h1 { font-size: 20px; margin: 0; font-weight: 600; }
  .badge { padding: 4px 10px; border-radius: 999px; background: ${statusColor}22; color: ${statusColor}; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  .logo { width: 28px; height: 28px; background: linear-gradient(135deg, #ff5470 0%, #1aff8c 100%); border-radius: 6px; }
  section { margin-top: 32px; }
  section h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: #8aa1b8; margin: 0 0 12px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td, th { padding: 8px 12px; border-bottom: 1px solid #1f2733; text-align: left; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .card { background: #131a23; padding: 16px; border-radius: 8px; border: 1px solid #1f2733; }
  .card .label { color: #8aa1b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
  .card .value { font-size: 22px; font-weight: 600; margin-top: 6px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
  .activity li { font-size: 13px; padding: 6px 0; border-bottom: 1px dashed #1f2733; list-style: none; color: #b0bcc8; }
  .activity .type { color: #8aa1b8; margin-right: 8px; font-family: ui-monospace, "SF Mono", monospace; font-size: 11px; }
  footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #1f2733; font-size: 13px; color: #8aa1b8; }
  footer .quote { font-style: italic; margin: 12px 0; color: #d8e0e8; }
  footer a { color: #1aff8c; text-decoration: none; }
  footer .forza { color: #ff5470; font-weight: 600; margin-top: 16px; }
  ul.svc-list { margin: 0; padding-left: 18px; font-size: 13px; }
  code { font-family: ui-monospace, "SF Mono", monospace; font-size: 12px; color: #b0bcc8; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="logo" aria-hidden="true"></div>
      <h1>${escapeHtml(c.title)}</h1>
      <span class="badge">${escapeHtml(statusLabel)}</span>
      <span style="margin-left:auto;font-size:12px;color:#8aa1b8;">${escapeHtml(c.lastUpdated)}: ${escapeHtml(data.generatedAt)}</span>
    </header>

    <section>
      <h2>${escapeHtml(c.serviceHealth)}</h2>
      <table>
        <tbody>
          ${componentRow(c.api, data.components.api.ok)}
          ${componentRow(c.db, data.components.db.ok, `${data.components.db.latencyMs} ms`)}
          ${componentRow(c.seeder, data.components.seeder.ok, `${data.components.seeder.enabled ? 'enabled' : 'disabled'} · ${data.components.seeder.activeRooms} rooms`)}
          ${componentRow(c.indexer, data.components.indexer.ok, `block ${data.components.indexer.lastBlock ?? 'n/a'} · lag ${data.components.indexer.lagSeconds ?? 'n/a'}s`)}
          ${componentRow(c.catalog, data.components.catalog.ok, `${data.components.catalog.matchCount} matches`)}
        </tbody>
      </table>
    </section>

    <section>
      <h2>${escapeHtml(c.chainsTitle)}</h2>
      <table>
        <tbody>
          ${data.chains
            .map((cn) => {
              const label =
                cn.healthy === true
                  ? c.chainHealthy
                  : cn.healthy === false
                  ? c.chainUnhealthy
                  : c.chainUnknown;
              const dotColor =
                cn.healthy === true
                  ? '#1aff8c'
                  : cn.healthy === false
                  ? '#ff5470'
                  : '#ffd166';
              const block = cn.lastBlockNumber ?? 'n/a';
              const lag = cn.lagSeconds === null ? 'n/a' : `${cn.lagSeconds}s`;
              const enabled = cn.enabled ? '' : ' (disabled)';
              return `<tr><td>${escapeHtml(cn.name)} <code>#${cn.chainId}</code>${escapeHtml(enabled)}</td><td><span class="dot" style="background:${dotColor}"></span>${escapeHtml(label)}</td><td>block ${escapeHtml(block)} &middot; lag ${escapeHtml(lag)}</td></tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </section>

    <section>
      <h2>${escapeHtml(c.liveMetrics)}</h2>
      <div class="grid">
        <div class="card"><div class="label">${escapeHtml(c.activeRooms)}</div><div class="value">${data.metrics.activeRooms}</div></div>
        <div class="card"><div class="label">${escapeHtml(c.totalRooms)}</div><div class="value">${data.metrics.totalRooms}</div></div>
        <div class="card"><div class="label">${escapeHtml(c.totalTipsToday)}</div><div class="value">${data.metrics.totalTipsToday}</div></div>
        <div class="card"><div class="label">${escapeHtml(c.totalTipsLifetime)}</div><div class="value">${data.metrics.totalTipsLifetime}</div></div>
        <div class="card"><div class="label">${escapeHtml(c.activePeers)}</div><div class="value">${data.metrics.activePeers}</div></div>
      </div>
    </section>

    <section>
      <h2>${escapeHtml(c.recentActivity)}</h2>
      <ul class="activity">
        ${
          data.recentEvents.length === 0
            ? `<li>${escapeHtml(c.noRecentEvents)}</li>`
            : data.recentEvents
                .map(
                  (e) =>
                    `<li><span class="type">${escapeHtml(e.type)}</span>${escapeHtml(e.summary)}</li>`
                )
                .join('')
        }
      </ul>
    </section>

    <section>
      <h2>${escapeHtml(c.thirdParty)}</h2>
      <ul class="svc-list">
        ${data.thirdPartyServices
          .map((s) => {
            const status =
              s.enabled === false
                ? ' (disabled)'
                : s.enabled === true
                ? ' (enabled)'
                : '';
            const urls = s.urls
              ? s.urls.map((u) => `<code>${escapeHtml(u)}</code>`).join(', ')
              : s.url
              ? `<code>${escapeHtml(s.url)}</code>`
              : '';
            return `<li>${escapeHtml(s.name)}${escapeHtml(status)} ${urls}</li>`;
          })
          .join('')}
      </ul>
    </section>

    <section>
      <h2>${escapeHtml(c.versions)}</h2>
      <table>
        <tbody>
          ${Object.entries(data.versions)
            .map(
              ([k, v]) =>
                `<tr><td>${escapeHtml(k)}</td><td><code>${escapeHtml(v)}</code></td></tr>`
            )
            .join('')}
        </tbody>
      </table>
    </section>

    <footer>
      <div>${escapeHtml(c.builtFor)}</div>
      ${
        quote
          ? `<div class="quote">"${escapeHtml(quote.text)}" — ${escapeHtml(quote.speaker)}</div>`
          : ''
      }
      <div>
        <a href="https://dorahacks.io/hackathon/tether-developers-cup" rel="noopener">Tether Developers Cup</a>
        · <a href="https://pears.com" rel="noopener">Pears</a>
        · <a href="/status?lang=en">English</a>
        · <a href="/status?lang=it">Italiano</a>
        · <a href="/status?lang=id">Bahasa Indonesia</a>
      </div>
      <div class="forza">${escapeHtml(c.forzaCurva)}</div>
    </footer>
  </div>
</body>
</html>`;
};

// =============================================================================
// Route plugin
// =============================================================================

// Split caches by value type so the generic stays honest (CODE_REVIEW W2
// Major #1). htmlCache holds rendered HTML strings keyed by `html:en` /
// `html:it`; dataCache holds the StatusData object keyed by `json`.
const htmlCache = new TtlCache<string>(2);
const dataCache = new TtlCache<StatusData>(1);

export const statusRoutes: FastifyPluginCallback = (
  app: FastifyInstance,
  _opts,
  done
) => {
  if (IS_PROD) {
    // Boot-time log so operators see the page is live.
    console.log('[Status] Public status page enabled at /status');
  }

  app.get(
    '/status',
    {
      config: {
        rateLimit: { max: STATUS_RATE_LIMIT_MAX, timeWindow: STATUS_RATE_LIMIT_WINDOW },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Lang resolution: explicit `?lang=` query (validated via i18n helper)
        // wins; otherwise we use the value populated by the global F9 preHandler
        // (which honours Accept-Language). Default 'en' if neither is set.
        const q = (request.query || {}) as Record<string, unknown>;
        const lang: Lang = isSupportedLang(q.lang)
          ? q.lang
          : isSupportedLang(request.lang)
          ? request.lang
          : 'en';
        const cacheKey = `html:${lang}`;
        const html = await htmlCache.memoize(cacheKey, STATUS_CACHE_TTL_MS, async () => {
          const data = await buildStatusData();
          return renderHtml(data, lang);
        });
        reply.header('Content-Type', 'text/html; charset=utf-8');
        reply.header('Cache-Control', `public, max-age=${Math.floor(STATUS_CACHE_TTL_MS / 1000)}`);
        // Feature-specific CSP override. The global helmet CSP is default-src
        // 'none' (SECURITY_AUDIT MED-03). This page renders inline CSS to survive
        // hotel-WiFi captive portals that strip CDNs, so we widen only what the
        // page actually needs. No scripts run on this page.
        reply.header(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        );
        return reply.code(200).send(html);
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  app.get(
    '/status.json',
    {
      config: {
        rateLimit: { max: STATUS_RATE_LIMIT_MAX, timeWindow: STATUS_RATE_LIMIT_WINDOW },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = await dataCache.memoize('json', STATUS_CACHE_TTL_MS, () => buildStatusData());
        reply.header('Cache-Control', `public, max-age=${Math.floor(STATUS_CACHE_TTL_MS / 1000)}`);
        return reply.code(200).send({ success: true, error: null, data });
      } catch (err) {
        return handleServerError(reply, err as Error);
      }
    }
  );

  done();
};
