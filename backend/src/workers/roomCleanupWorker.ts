import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { ROOM_CLEANUP_CRON } from '../config/main-config.ts';

let isRunning = false;

const cleanupOnce = async (): Promise<void> => {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // 1. Soft-delete rooms whose expiresAt has passed but aren't soft-deleted yet.
    const expired = await prismaQuery.room.updateMany({
      where: { deletedAt: null, expiresAt: { lt: now } },
      data: { deletedAt: now },
    });
    if (expired.count > 0) {
      console.log(`[RoomCleanup] Soft-deleted ${expired.count} expired rooms`);
    }

    // 2. Backstop soft-delete: rooms whose expiresAt is older than 7 days
    //    should already be soft-deleted by step 1, but if any slipped through
    //    (rare; only possible if deletedAt was nulled out manually) we mark
    //    them now. Hard-delete is a deliberate manual ops decision, NOT a cron
    //    job, per the project's soft-delete-only policy (schema.prisma:10 and
    //    /Users/macbookair/.claude/rules/database.md). Audit history of expired
    //    rooms is worth more than the negligible disk space they consume.
    const backstop = await prismaQuery.room.updateMany({
      where: { deletedAt: null, expiresAt: { lt: sevenDaysAgo } },
      data: { deletedAt: now },
    });
    if (backstop.count > 0) {
      console.log(`[RoomCleanup] Backstop soft-deleted ${backstop.count} stale rooms`);
    }

    // 3. Seeder teardown for orphan slugs is owned by seederReconcileWorker;
    //    we don't duplicate that work here.
  } catch (err) {
    console.error('[RoomCleanup] error:', (err as Error)?.message || err);
  } finally {
    isRunning = false;
  }
};

export const startRoomCleanupWorker = (): void => {
  console.log(`[RoomCleanup] Worker scheduled: ${ROOM_CLEANUP_CRON}`);
  cron.schedule(ROOM_CLEANUP_CRON, cleanupOnce);
};
