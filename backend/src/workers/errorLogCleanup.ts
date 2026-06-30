import cron from 'node-cron';
import { prismaQuery } from '../lib/prisma.ts';
import { ERROR_LOG_MAX_RECORDS, ERROR_LOG_CLEANUP_INTERVAL } from '../config/main-config.ts';

let isRunning = false;

const cleanupErrorLogs = async (): Promise<void> => {
  if (isRunning) {
    console.log('[ErrorLogCleanup] Previous cleanup still running, skipping...');
    return;
  }

  isRunning = true;
  console.log('[ErrorLogCleanup] Starting cleanup...');

  try {
    const count = await prismaQuery.errorLog.count();

    if (count > ERROR_LOG_MAX_RECORDS) {
      const recordsToDelete = count - ERROR_LOG_MAX_RECORDS;

      // Get IDs of oldest records to delete
      const oldestRecords = await prismaQuery.errorLog.findMany({
        orderBy: { createdAt: 'asc' },
        take: recordsToDelete,
        select: { id: true },
      });

      const idsToDelete = oldestRecords.map((r) => r.id);

      // Delete oldest records
      await prismaQuery.errorLog.deleteMany({
        where: {
          id: { in: idsToDelete },
        },
      });

      console.log(
        `[ErrorLogCleanup] Deleted ${recordsToDelete} old error logs (was ${count}, now ${ERROR_LOG_MAX_RECORDS})`
      );
    } else {
      console.log(`[ErrorLogCleanup] No cleanup needed (${count}/${ERROR_LOG_MAX_RECORDS} records)`);
    }
  } catch (error) {
    console.error('[ErrorLogCleanup] Error during cleanup:', error);
  } finally {
    isRunning = false;
  }
};

export const startErrorLogCleanupWorker = (): void => {
  console.log(`[ErrorLogCleanup] Worker scheduled: ${ERROR_LOG_CLEANUP_INTERVAL}`);

  cron.schedule(ERROR_LOG_CLEANUP_INTERVAL, cleanupErrorLogs);

  // Run initial cleanup on startup
  cleanupErrorLogs();
};
