import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { seederSupervisor } from '../lib/pears/seeder.ts';
import { SEEDER_RECONCILE_CRON } from '../config/main-config.ts';

let isRunning = false;

const reconcileOnce = async (): Promise<void> => {
  if (!seederSupervisor.isEnabled()) return;
  if (isRunning) return;
  isRunning = true;
  try {
    const now = new Date();
    const activeRooms = await prismaQuery.room.findMany({
      where: { deletedAt: null, expiresAt: { gt: now } },
      select: { slug: true },
    });
    const desiredSlugs = new Set(activeRooms.map((r) => r.slug));
    const currentSlugs = new Set(seederSupervisor.getAllSlugs());

    // Stop extras FIRST to free up cap headroom before trying to start new ones.
    // This is important on a stale snapshot: a row deleted between this scan
    // and the previous tick may be holding a slot that a newer row needs.
    for (const slug of currentSlugs) {
      if (!desiredSlugs.has(slug)) seederSupervisor.stopRoom(slug);
    }
    // Start missing. spawnRoom() is the authoritative cap gate — it refuses
    // beyond SEEDER_MAX_ROOMS, so even a stale snapshot cannot exceed the cap.
    for (const slug of desiredSlugs) {
      if (!currentSlugs.has(slug)) seederSupervisor.spawnRoom(slug);
    }
  } catch (err) {
    console.error('[SeederReconcile] error:', (err as Error)?.message || err);
  } finally {
    isRunning = false;
  }
};

export const startSeederReconcileWorker = (): void => {
  if (!seederSupervisor.isEnabled()) {
    console.log('[SeederReconcile] Seeder disabled (ENABLE_SEEDER=false); worker not started');
    return;
  }
  console.log(`[SeederReconcile] Worker scheduled: ${SEEDER_RECONCILE_CRON}`);
  cron.schedule(SEEDER_RECONCILE_CRON, reconcileOnce);
  // Initial run after a short delay to let the server start.
  setTimeout(() => void reconcileOnce(), 3000);
};
