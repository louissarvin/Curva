/**
 * F14 MCP resource implementations.
 *
 * Resources are static-ish JSON blobs the agent can fetch via `resources/read`.
 * All three resources are cheap: phrasebook + distribution manifest are read
 * from module state; status is assembled with a light DB roundtrip.
 *
 * Per ARCHITECTURE.md F14 the URIs are:
 *   curva://phrasebook      -> full phrasebook JSON
 *   curva://status          -> /status.json shape
 *   curva://distribution    -> /distribution shape
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getConfig as getDistributionConfig,
  getInstallInstructions,
  getStatus as getDistributionStatus,
} from '../pears/appDistribution.ts';
import { prismaQuery } from '../prisma.ts';
import { seederSupervisor } from '../pears/seeder.ts';
import { eventBus } from '../activity/eventBus.ts';
import { TtlCache } from '../cache.ts';
import {
  SERVICE_STARTED_AT,
  SERVICE_VERSION,
} from '../../config/main-config.ts';
import {
  registerResource,
  type McpResource,
  type McpResourceContent,
} from './server.ts';

// -----------------------------------------------------------------------------
// Phrasebook resource — cached at module load.
// -----------------------------------------------------------------------------

interface PhrasebookRaw {
  quotes?: unknown[];
  italian_phrases?: unknown[];
  indonesian_phrases?: unknown[];
  [key: string]: unknown;
}

let phrasebookRaw: PhrasebookRaw | null = null;
let phrasebookFullText: string | null = null;

const loadPhrasebookRaw = (): PhrasebookRaw => {
  if (phrasebookRaw !== null) return phrasebookRaw;
  try {
    const txt = readFileSync(
      resolve(process.cwd(), 'src/data/phrasebook.json'),
      'utf8'
    );
    phrasebookRaw = JSON.parse(txt) as PhrasebookRaw;
  } catch {
    phrasebookRaw = { quotes: [], italian_phrases: [] };
  }
  return phrasebookRaw;
};

const loadPhrasebookText = (): string => {
  if (phrasebookFullText !== null) return phrasebookFullText;
  phrasebookFullText = JSON.stringify(loadPhrasebookRaw(), null, 2);
  return phrasebookFullText;
};

// Lang-scoped variants: filter the phrasebook JSON to a language-specific
// subset. Query-string-in-URI resources are permitted by MCP; per ARCH §21 F14
// spec we register them as distinct URIs so agents can discover them via
// `resources/list`.
const buildLangText = (lang: 'it' | 'id'): string => {
  const raw = loadPhrasebookRaw();
  if (lang === 'it') {
    return JSON.stringify(
      {
        quotes: raw.quotes ?? [],
        italian_phrases: raw.italian_phrases ?? [],
      },
      null,
      2
    );
  }
  // 'id' — Indonesian subset. Falls back to empty array if the underlying
  // catalogue has no entries yet; the resource still resolves cleanly.
  return JSON.stringify(
    {
      quotes: raw.quotes ?? [],
      indonesian_phrases: raw.indonesian_phrases ?? [],
    },
    null,
    2
  );
};

const phrasebookResource: McpResource = {
  uri: 'curva://phrasebook',
  name: 'Curva Phrasebook',
  description: 'Ardoino quotes + Italian ultras phrase catalogue used by Curva clients.',
  mimeType: 'application/json',
  async read(): Promise<McpResourceContent> {
    return {
      uri: 'curva://phrasebook',
      mimeType: 'application/json',
      text: loadPhrasebookText(),
    };
  },
};

const phrasebookItResource: McpResource = {
  uri: 'curva://phrasebook?lang=it',
  name: 'Curva Phrasebook (Italian)',
  description: 'Italian-filtered subset of the Curva phrasebook (quotes + italian_phrases).',
  mimeType: 'application/json',
  async read(): Promise<McpResourceContent> {
    return {
      uri: 'curva://phrasebook?lang=it',
      mimeType: 'application/json',
      text: buildLangText('it'),
    };
  },
};

const phrasebookIdResource: McpResource = {
  uri: 'curva://phrasebook?lang=id',
  name: 'Curva Phrasebook (Indonesian)',
  description: 'Indonesian-filtered subset of the Curva phrasebook (quotes + indonesian_phrases).',
  mimeType: 'application/json',
  async read(): Promise<McpResourceContent> {
    return {
      uri: 'curva://phrasebook?lang=id',
      mimeType: 'application/json',
      text: buildLangText('id'),
    };
  },
};

// -----------------------------------------------------------------------------
// Status resource — recomputes on each read (cheap, DB ping + counts).
// The rendered blob is deliberately a subset of /status.json — no dep versions,
// no third-party URLs — because agents mostly want the health flags.
// -----------------------------------------------------------------------------

// W4-MED-05: 10s TTL cache prevents unauth MCP clients from driving DB load
// via repeated resources/read curva://status. The 4 DB round-trips (SELECT 1
// + 3 counts) collapse to at most 6/min in steady state even under a burst.
const STATUS_CACHE_TTL_MS = 10_000;
const statusCache = new TtlCache<string>(2);

const buildStatusPayloadText = async (): Promise<string> => {
  const now = new Date();
  let db = { ok: false, latencyMs: 0 };
  const dbStart = Date.now();
  try {
    await prismaQuery.$queryRaw`SELECT 1`;
    db = { ok: true, latencyMs: Date.now() - dbStart };
  } catch {
    db = { ok: false, latencyMs: Date.now() - dbStart };
  }
  let activeRooms = 0;
  let totalRooms = 0;
  let totalTipsLifetime = 0;
  if (db.ok) {
    const [ar, tr, tl] = await Promise.all([
      prismaQuery.room
        .count({ where: { deletedAt: null, expiresAt: { gt: now } } })
        .catch(() => 0),
      prismaQuery.room.count().catch(() => 0),
      prismaQuery.tipEvent.count().catch(() => 0),
    ]);
    activeRooms = ar;
    totalRooms = tr;
    totalTipsLifetime = tl;
  }
  const seederInfo = {
    enabled: seederSupervisor.isEnabled(),
    activeRooms: seederSupervisor.getActiveRoomCount(),
    totalPeers: seederSupervisor.getTotalPeers(),
  };
  const recent = eventBus.getRecent({ limit: 5 }).map((e) => ({
    type: e.type,
    ts: new Date(e.ts).toISOString(),
  }));
  const payload = {
    status: db.ok ? 'ok' : 'down',
    generatedAt: now.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - SERVICE_STARTED_AT) / 1000),
    version: SERVICE_VERSION,
    components: { db, seeder: seederInfo },
    metrics: { activeRooms, totalRooms, totalTipsLifetime },
    recentEvents: recent,
  };
  return JSON.stringify(payload, null, 2);
};

const statusResource: McpResource = {
  uri: 'curva://status',
  name: 'Curva Companion status',
  description:
    'Backend health snapshot: DB ping, indexer lag, seeder state, room counts, tip lifetime.',
  mimeType: 'application/json',
  async read(): Promise<McpResourceContent> {
    const text = await statusCache.memoize(
      'status',
      STATUS_CACHE_TTL_MS,
      buildStatusPayloadText
    );
    return {
      uri: 'curva://status',
      mimeType: 'application/json',
      text,
    };
  },
};

// -----------------------------------------------------------------------------
// Distribution resource — reads the F13 manifest.
// -----------------------------------------------------------------------------

const distributionResource: McpResource = {
  uri: 'curva://distribution',
  name: 'Curva Pear app distribution',
  description:
    'Pear app distribution manifest: app key, current version, install instructions.',
  mimeType: 'application/json',
  async read(): Promise<McpResourceContent> {
    const cfg = getDistributionConfig();
    const status = getDistributionStatus();
    const install = getInstallInstructions();
    const payload = {
      appKey: cfg.appKey,
      pearLink: cfg.appKey ? `pear://${cfg.appKey}` : null,
      version: cfg.version,
      releasedAt: cfg.releasedAt,
      description: cfg.description,
      howToInstall: install,
      seederRunning: status.seederRunning,
      seederUptimeSeconds: status.seederUptimeSeconds ?? 0,
      distributionEnabled: cfg.enabled,
    };
    return {
      uri: 'curva://distribution',
      mimeType: 'application/json',
      text: JSON.stringify(payload, null, 2),
    };
  },
};

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export const registerAllResources = (): void => {
  registerResource(phrasebookResource);
  registerResource(phrasebookItResource);
  registerResource(phrasebookIdResource);
  registerResource(statusResource);
  registerResource(distributionResource);
};

// Test-only handles.
export const __resourcesForTest = {
  phrasebookResource,
  phrasebookItResource,
  phrasebookIdResource,
  statusResource,
  distributionResource,
};

/**
 * Test-only: drop the status cache so a re-read hits the DB.
 */
export const __resetStatusCacheForTest = (): void => {
  statusCache.clear();
};
