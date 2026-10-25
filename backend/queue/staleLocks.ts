import { listStaleLockerIds } from '@queries/queue/listStaleLockerIds';
import type { WorkerUtils } from 'graphile-worker';
import { logger } from '../src/logger';
import { TASK_TIME_LIMIT_SECONDS } from './worker';

/**
 * How long a job may stay locked before it counts as abandoned. A live
 * worker ends every attempt within the task time limit and lets go of its
 * job, so a lock outlasting that by a margin belongs to a worker that
 * crashed or froze.
 */
export const STALE_LOCK_SECONDS = TASK_TIME_LIMIT_SECONDS + 60;

/** How often a running worker frees abandoned jobs. */
const SWEEP_INTERVAL_MS = 30_000;

/** Frees every abandoned job, so it runs again now instead of hours later. */
export async function releaseStaleLocks(utils: Pick<WorkerUtils, 'forceUnlockWorkers'>) {
  const workerIds = await listStaleLockerIds({ olderThanSeconds: STALE_LOCK_SECONDS });
  if (workerIds.length === 0) return;
  await utils.forceUnlockWorkers(workerIds);
  logger.warn({ workerIds }, 'released queue jobs locked for too long');
}

/** Frees abandoned jobs now and periodically; returns a function that stops the sweep. */
export function keepReleasingStaleLocks(utils: Pick<WorkerUtils, 'forceUnlockWorkers'>) {
  const sweep = () =>
    releaseStaleLocks(utils).catch((error: unknown) => {
      logger.warn({ err: error }, 'could not release abandoned queue jobs');
    });
  void sweep();
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
