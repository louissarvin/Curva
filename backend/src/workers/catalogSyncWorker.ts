import cron from 'node-cron';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prismaQuery } from '../lib/prisma.ts';
import {
  CATALOG_SYNC_CRON,
  FOOTBALL_DATA_API_KEY,
  FOOTBALL_DATA_COMPETITION,
} from '../config/main-config.ts';

const SEED_PATH = resolve(process.cwd(), 'src/data/world-cup-2026.json');

interface SeedTeam {
  code: string;
  name: string;
  iso2: string;
  group: string | null;
  flagUrl: string;
  placeholder?: boolean;
}

interface SeedMatch {
  externalId: number;
  homeTeamCode: string;
  awayTeamCode: string;
  kickoffUtc: string;
  stage: 'group' | 'r16' | 'qf' | 'sf' | 'third_place' | 'final';
  status: 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled';
  groupLabel: string | null;
  venue: string | null;
}

interface SeedFile {
  meta: { competition: string };
  teams: SeedTeam[];
  matches: SeedMatch[];
}

let isRunning = false;

const loadSeed = (): SeedFile => {
  const raw = readFileSync(SEED_PATH, 'utf8');
  return JSON.parse(raw) as SeedFile;
};

const upsertTeams = async (teams: SeedTeam[]): Promise<{ count: number; codeToId: Map<string, string> }> => {
  const codeToId = new Map<string, string>();
  let count = 0;
  for (const t of teams) {
    const code = t.code.toUpperCase();
    const row = await prismaQuery.team.upsert({
      where: { code },
      create: {
        code,
        name: t.name,
        flagUrl: t.flagUrl ?? null,
        groupLabel: t.group ?? null,
      },
      update: {
        name: t.name,
        flagUrl: t.flagUrl ?? null,
        groupLabel: t.group ?? null,
      },
    });
    codeToId.set(code, row.id);
    count += 1;
  }
  return { count, codeToId };
};

const upsertMatches = async (
  matches: SeedMatch[],
  codeToId: Map<string, string>
): Promise<number> => {
  let count = 0;
  for (const m of matches) {
    const homeId = codeToId.get(m.homeTeamCode.toUpperCase());
    const awayId = codeToId.get(m.awayTeamCode.toUpperCase());
    if (!homeId || !awayId) {
      console.warn(
        `[CatalogSync] Skipping match ${m.externalId}: missing team(s) ${m.homeTeamCode}/${m.awayTeamCode}`
      );
      continue;
    }
    await prismaQuery.match.upsert({
      where: { externalId: m.externalId },
      create: {
        externalId: m.externalId,
        homeTeamId: homeId,
        awayTeamId: awayId,
        kickoffUtc: new Date(m.kickoffUtc),
        stage: m.stage,
        status: m.status,
        groupLabel: m.groupLabel,
        venue: m.venue,
      },
      update: {
        // We intentionally DO NOT overwrite homeScore/awayScore on every sync.
        // The football-data refresh path (below) is the only thing that updates those.
        homeTeamId: homeId,
        awayTeamId: awayId,
        kickoffUtc: new Date(m.kickoffUtc),
        stage: m.stage,
        // Don't downgrade `status` from finished back to scheduled if seed says scheduled
        // and DB already says finished. Only set when current is scheduled.
        groupLabel: m.groupLabel,
        venue: m.venue,
      },
    });
    count += 1;
  }
  return count;
};

const refreshFromFootballData = async (): Promise<{ updated: number } | null> => {
  if (!FOOTBALL_DATA_API_KEY) return null;

  try {
    const res = await fetch(
      `https://api.football-data.org/v4/competitions/${FOOTBALL_DATA_COMPETITION}/matches`,
      { headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY }, signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) {
      console.warn(`[CatalogSync] football-data ${res.status} ${res.statusText}`);
      return null;
    }
    const body = (await res.json()) as {
      matches?: Array<{
        id: number;
        status: string;
        score?: { fullTime?: { home: number | null; away: number | null } };
      }>;
    };
    const list = body.matches ?? [];
    let updated = 0;
    for (const m of list) {
      const lowered = (m.status || '').toLowerCase();
      const normalized =
        lowered === 'finished'
          ? 'finished'
          : lowered === 'live' || lowered === 'in_play' || lowered === 'paused'
          ? 'live'
          : lowered === 'postponed'
          ? 'postponed'
          : lowered === 'cancelled' || lowered === 'canceled'
          ? 'cancelled'
          : 'scheduled';

      try {
        const existing = await prismaQuery.match.findUnique({ where: { externalId: m.id } });
        if (!existing) continue;
        await prismaQuery.match.update({
          where: { externalId: m.id },
          data: {
            status: normalized,
            homeScore: m.score?.fullTime?.home ?? existing.homeScore,
            awayScore: m.score?.fullTime?.away ?? existing.awayScore,
          },
        });
        updated += 1;
      } catch (err) {
        console.warn(`[CatalogSync] Failed to update match ${m.id}:`, (err as Error)?.message);
      }
    }
    return { updated };
  } catch (err) {
    console.warn('[CatalogSync] football-data refresh failed:', (err as Error)?.message);
    return null;
  }
};

const syncOnce = async (): Promise<void> => {
  if (isRunning) {
    console.log('[CatalogSync] Previous run still active, skipping...');
    return;
  }
  isRunning = true;
  const startedAt = Date.now();
  try {
    console.log('[CatalogSync] Starting sync from JSON seed...');
    const seed = loadSeed();
    const { count: teamsUpserted, codeToId } = await upsertTeams(seed.teams);
    const matchesUpserted = await upsertMatches(seed.matches, codeToId);

    let source = 'json_seed';
    const apiResult = await refreshFromFootballData();
    if (apiResult) {
      source = 'json_seed+football_data';
      console.log(`[CatalogSync] football-data refresh updated ${apiResult.updated} matches`);
    }

    await prismaQuery.catalogSync.create({
      data: {
        source,
        status: 'ok',
        matchesUpserted,
        teamsUpserted,
      },
    });
    console.log(
      `[CatalogSync] OK in ${Date.now() - startedAt}ms — ${teamsUpserted} teams, ${matchesUpserted} matches`
    );
  } catch (err) {
    console.error('[CatalogSync] FAILED:', (err as Error)?.message);
    try {
      await prismaQuery.catalogSync.create({
        data: {
          source: 'json_seed',
          status: 'error',
          errorMessage: ((err as Error)?.message || String(err)).slice(0, 500),
        },
      });
    } catch {
      /* swallow logging failure */
    }
  } finally {
    isRunning = false;
  }
};

export const startCatalogSyncWorker = (): void => {
  console.log(`[CatalogSync] Worker scheduled: ${CATALOG_SYNC_CRON}`);
  cron.schedule(CATALOG_SYNC_CRON, syncOnce);
  // Run once on startup so the catalog is populated immediately.
  void syncOnce();
};

// Exported for tests
export const __runCatalogSyncOnce = syncOnce;
