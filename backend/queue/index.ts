import { env } from '@config/env';
import { listLockingWorkerIds } from '@queries/queue/listLockingWorkerIds';
import { type Runner, type WorkerUtils, makeWorkerUtils, run } from 'graphile-worker';
import { logger } from '../src/logger';
import { type RegisteredTask, queueRuntime } from './worker';

/** The database schema the queue keeps its tables in, apart from the app's. */
export const QUEUE_SCHEMA = 'queues';

/** Jobs run side by side; work on one Thread still serializes on its own lock. */
const CONCURRENT_JOBS = 4;

let active: { runner: Runner; utils: WorkerUtils } | null = null;

/**
 * Frees the jobs a crashed process left locked, so they run again now
 * instead of hours later. Every lock found before this process starts its
 * worker belongs to a process that is gone: one backend runs the queue.
 */
async function releaseLocksOfPastProcesses(utils: WorkerUtils): Promise<void> {
  const workerIds = await listLockingWorkerIds();
  if (workerIds.length === 0) return;
  await utils.forceUnlockWorkers(workerIds);
  logger.warn({ workerIds }, 'released queue jobs held by a previous process');
}

/**
 * Installs or upgrades the queue's schema, then starts working the given
 * tasks in this process. Jobs already waiting, including those a restart
 * interrupted, run from here on.
 */
export async function startQueue(tasks: readonly RegisteredTask[]): Promise<void> {
  if (active) return;
  const utils = await makeWorkerUtils({
    connectionString: env.DATABASE_URL,
    schema: QUEUE_SCHEMA,
  });
  await utils.migrate();
  await releaseLocksOfPastProcesses(utils);
  const runtime = queueRuntime(tasks, utils);
  const runner = await run({
    connectionString: env.DATABASE_URL,
    schema: QUEUE_SCHEMA,
    concurrency: CONCURRENT_JOBS,
    noHandleSignals: true,
    taskList: runtime.taskList,
    events: runtime.events,
    logger: runtime.logger,
  });
  active = { runner, utils };
}

/** Lets running jobs finish, within the engine's grace period, then stops the worker. */
export async function stopQueue(): Promise<void> {
  if (!active) return;
  const { runner, utils } = active;
  active = null;
  await runner.stop();
  await utils.release();
}
