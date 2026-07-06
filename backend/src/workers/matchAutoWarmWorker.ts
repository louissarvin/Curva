/**
 * Match auto-warm worker (F2).
 *
 * Pre-warms a Hyperswarm topic for any match whose kickoff is within
 * MATCH_AUTO_WARM_LEAD_MINUTES (default 30). Sweeps auto-warmed rooms once
 * the match window closes (kickoff + ROOM_MATCH_DURATION_HOURS +
 * ROOM_POST_MATCH_BUFFER_HOURS).
 *
 * Worker is OFF by default: if AUTO_WARM_HOST_OWNER_ADDRESS or
 * AUTO_WARM_HOST_SMART_ADDRESS is unset, the cron tick logs once and returns.
 * No exceptions, no process crashes. Per ARCH 19 F2.
 */

import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { seederSupervisor } from '../lib/pears/seeder.ts';
import { eventBus } from '../lib/activity/eventBus.ts';
import {
  slugForMatch,
  type CurvaMatchStage,
} from '../lib/integrations/footballData.ts';
import {
  AUTO_WARM_HOST_OWNER_ADDRESS,
  AUTO_WARM_HOST_SMART_ADDRESS,
  MATCH_AUTO_WARM_CRON,
  MATCH_AUTO_WARM_LEAD_MINUTES,
  ROOM_MATCH_DURATION_HOURS,
  ROOM_POST_MATCH_BUFFER_HOURS,
  SEEDER_MAX_ROOMS,
} from '../config/main-config.ts';

// F2 knockout warm horizon. The 24h window covers the full WC 2026 knockout
// bracket ordinal counters for a single tick without ever calling the
// football-data.org API (worker reads only DB rows). Group-stage matches keep
// the tighter MATCH_AUTO_WARM_LEAD_MINUTES horizon to protect the 10 req/min
// free-tier budget elsewhere.
const KNOCKOUT_WARM_HORIZON_MS = 24 * 3_600_000;
const KNOCKOUT_STAGES: readonly CurvaMatchStage[] = [
  'r16',
  'qf',
  'sf',
  'third_place',
  'final',
];

let isRunning = false;

// Throttle the disabled-state log to at most once per hour. The cron fires
// every 5 min so a permanently-disabled worker would otherwise spam 288
// lines/day. First-run fires immediately so the warning is visible on boot.
// See CODE_REVIEW W2 Major #3.
const DISABLED_LOG_THROTTLE_MS = 3_600_000;
let lastDisabledLogAt = 0;

/**
 * Test seam: allow tests to inject Date.now via this hook.
 * Exported and re-assignable; not used by production code.
 */
export const __testHooks = {
  now: () => Date.now(),
  resetDisabledLog: (): void => {
    lastDisabledLogAt = 0;
  },
};

const isEnabled = (): boolean =>
  Boolean(AUTO_WARM_HOST_OWNER_ADDRESS && AUTO_WARM_HOST_SMART_ADDRESS);

/**
 * Single tick. Exported for testability.
 */
export const runAutoWarmTick = async (): Promise<void> => {
  if (!isEnabled()) {
    const now = __testHooks.now();
    if (lastDisabledLogAt === 0 || now - lastDisabledLogAt > DISABLED_LOG_THROTTLE_MS) {
      console.log('[matchAutoWarmWorker] disabled (env unset)');
      lastDisabledLogAt = now;
    }
    return;
  }
  if (isRunning) return;
  isRunning = true;

  try {
    const now = __testHooks.now();
    const nowDate = new Date(now);
    const matchDurationMs =
      (ROOM_MATCH_DURATION_HOURS + ROOM_POST_MATCH_BUFFER_HOURS) * 3_600_000;
    const shortWarmEnd = new Date(now + MATCH_AUTO_WARM_LEAD_MINUTES * 60_000);
    const longWarmEnd = new Date(now + KNOCKOUT_WARM_HORIZON_MS);

    // ----- Warm pass -----
    //
    // Two DB reads (no football-data.org calls):
    //   1. Group-stage matches inside the tight lead window (legacy path).
    //   2. Knockout matches inside the 24h window (F2 addition).
    //
    // Ordinal counter is derived from kickoffUtc ordering within each stage,
    // so `wc2026-sf1` and `wc2026-sf2` are stable across ticks (sf1 kicks off
    // Jul 14, sf2 kicks off Jul 15). We compute ordinals per tick from the
    // knockout query result rather than storing them, so the slug is a pure
    // function of stage + externalId + kickoff order.
    const [groupUpcoming, knockoutUpcoming] = await Promise.all([
      prismaQuery.match.findMany({
        where: {
          status: 'scheduled',
          stage: 'group',
          kickoffUtc: { gt: nowDate, lt: shortWarmEnd },
        },
        select: { id: true, kickoffUtc: true, stage: true, externalId: true },
        orderBy: { kickoffUtc: 'asc' },
      }),
      prismaQuery.match.findMany({
        where: {
          status: 'scheduled',
          stage: { in: ['r16', 'qf', 'sf', 'third_place', 'final'] },
          kickoffUtc: { gt: nowDate, lt: longWarmEnd },
        },
        select: { id: true, kickoffUtc: true, stage: true, externalId: true },
        orderBy: [{ stage: 'asc' }, { kickoffUtc: 'asc' }],
      }),
    ]);

    // Assign per-stage ordinals to knockout matches based on kickoff order.
    const ordinalByStage = new Map<string, number>();
    const toWarm: Array<{
      id: string;
      slug: string;
      kickoffUtc: Date;
    }> = [];
    for (const m of groupUpcoming) {
      toWarm.push({
        id: m.id,
        kickoffUtc: m.kickoffUtc,
        slug: slugForMatch({
          stage: 'group',
          phaseOrdinal: 0,
          externalId: m.externalId,
        }),
      });
    }
    for (const m of knockoutUpcoming) {
      const stage = m.stage as CurvaMatchStage;
      // Skip stages we do not recognise as knockout (defence in depth against
      // schema drift). The DB filter above should already prevent this.
      if (!KNOCKOUT_STAGES.includes(stage)) continue;
      const nextOrdinal = (ordinalByStage.get(stage) ?? 0) + 1;
      ordinalByStage.set(stage, nextOrdinal);
      toWarm.push({
        id: m.id,
        kickoffUtc: m.kickoffUtc,
        slug: slugForMatch({
          stage,
          phaseOrdinal: nextOrdinal,
          externalId: m.externalId,
        }),
      });
    }

    // Cap total warmed rooms per tick by SEEDER_MAX_ROOMS. The seeder itself
    // enforces its own cap; ours is the upstream guard so the DB never grows
    // past what the seeder pool can serve.
    let warmedThisTick = 0;

    for (const m of toWarm) {
      if (warmedThisTick >= SEEDER_MAX_ROOMS) {
        console.log(
          `[matchAutoWarmWorker] SEEDER_MAX_ROOMS=${SEEDER_MAX_ROOMS} reached; skipping ${toWarm.length - warmedThisTick} rooms`
        );
        break;
      }
      const slug = m.slug;

      // Idempotency + slug-squat defense in depth: skip if an active auto-room
      // already exists. If a row exists with the auto- slug but is NOT owned by
      // the configured AUTO_WARM_HOST_SMART_ADDRESS, refuse to overwrite — the
      // POST /rooms reservation check should prevent this, but if a stale row
      // somehow predates the reservation, do not silently hijack it. See
      // SECURITY_AUDIT.md W2-HIGH-01.
      const existing = await prismaQuery.room.findUnique({ where: { slug } });
      if (existing) {
        if (
          existing.hostSmartAddress.toLowerCase() !==
          (AUTO_WARM_HOST_SMART_ADDRESS as string).toLowerCase()
        ) {
          console.warn(
            `[matchAutoWarmWorker] slug ${slug} taken by foreign host (${existing.hostSmartAddress}); refusing to overwrite`
          );
          continue;
        }
        if (!existing.deletedAt) continue;
      }

      const expiresAt = new Date(m.kickoffUtc.getTime() + matchDurationMs);

      try {
        await prismaQuery.room.upsert({
          where: { slug },
          create: {
            slug,
            matchId: m.id,
            hostHandle: 'Curva',
            // We assert AUTO_WARM_HOST_*_ADDRESS are set in isEnabled() above.
            hostSmartAddress: AUTO_WARM_HOST_SMART_ADDRESS as string,
            hostOwnerAddress: AUTO_WARM_HOST_OWNER_ADDRESS as string,
            pearLink: `pear://curva/room/${slug}?warm=true`,
            expiresAt,
            isAutoWarmed: true,
          },
          update: { deletedAt: null, isAutoWarmed: true, expiresAt },
        });
      } catch (err) {
        console.error(
          `[matchAutoWarmWorker] upsert failed for ${slug}:`,
          (err as Error)?.message || err
        );
        continue;
      }

      warmedThisTick += 1;

      // Best-effort seeder spawn. If the supervisor refuses (cap, disabled)
      // we still keep the row — the seederReconcileWorker will retry on its
      // next tick once capacity opens up.
      if (seederSupervisor.isEnabled()) {
        seederSupervisor.spawnRoom(slug);
      }

      try {
        eventBus.publish('match.starting_soon', {
          matchId: m.id,
          slug,
          kickoffUtc: m.kickoffUtc.toISOString(),
          minutesUntilKickoff: Math.max(
            0,
            Math.round((m.kickoffUtc.getTime() - now) / 60_000)
          ),
        });
      } catch (err) {
        console.warn('[matchAutoWarmWorker] eventBus publish failed:', (err as Error)?.message);
      }
    }

    // ----- Sweep pass: soft-delete expired auto-rooms.
    const expiredCandidates = await prismaQuery.room.findMany({
      where: { isAutoWarmed: true, deletedAt: null },
      include: { match: { select: { kickoffUtc: true } } },
    });
    for (const r of expiredCandidates) {
      if (!r.match) continue;
      if (r.match.kickoffUtc.getTime() + matchDurationMs >= now) continue;

      await prismaQuery.room.update({
        where: { id: r.id },
        data: { deletedAt: new Date(now) },
      });
      seederSupervisor.stopRoom(r.slug);
      try {
        eventBus.publish('room.deleted', { slug: r.slug, reason: 'auto-cleanup' });
      } catch (err) {
        console.warn('[matchAutoWarmWorker] eventBus publish failed:', (err as Error)?.message);
      }
    }
  } catch (err) {
    console.error('[matchAutoWarmWorker] tick failed:', (err as Error)?.message || err);
  } finally {
    isRunning = false;
  }
};

export const startMatchAutoWarmWorker = (): void => {
  if (!isEnabled()) {
    console.warn(
      '[matchAutoWarmWorker] Disabled (AUTO_WARM_HOST_OWNER_ADDRESS / AUTO_WARM_HOST_SMART_ADDRESS not set)'
    );
    // Still schedule a no-op cron so an operator who sets the env later via
    // a redeploy gets the worker without code changes — runAutoWarmTick()
    // is the gate, not the schedule itself.
    cron.schedule(MATCH_AUTO_WARM_CRON, runAutoWarmTick);
    return;
  }
  console.log(`[matchAutoWarmWorker] scheduled: ${MATCH_AUTO_WARM_CRON}`);
  cron.schedule(MATCH_AUTO_WARM_CRON, runAutoWarmTick);
};
