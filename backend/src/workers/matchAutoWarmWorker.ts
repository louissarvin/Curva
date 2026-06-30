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
  AUTO_WARM_HOST_OWNER_ADDRESS,
  AUTO_WARM_HOST_SMART_ADDRESS,
  MATCH_AUTO_WARM_CRON,
  MATCH_AUTO_WARM_LEAD_MINUTES,
  ROOM_MATCH_DURATION_HOURS,
  ROOM_POST_MATCH_BUFFER_HOURS,
} from '../config/main-config.ts';

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
    const warmWindowEnd = new Date(now + MATCH_AUTO_WARM_LEAD_MINUTES * 60_000);

    // ----- Warm pass: create or reactivate auto-rooms for upcoming matches.
    const upcoming = await prismaQuery.match.findMany({
      where: {
        status: 'scheduled',
        kickoffUtc: { gt: nowDate, lt: warmWindowEnd },
      },
      select: { id: true, kickoffUtc: true },
    });

    for (const m of upcoming) {
      const slug = `auto-${m.id}`;

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
            pearLink: `pear://curva?room=${slug}`,
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
