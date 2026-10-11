import { env } from '@config/env';
import type { MemoryFeature } from '@services/memory';
import { type Runner, type WorkerUtils, makeWorkerUtils, run } from 'graphile-worker';
import { keepReleasingStaleLocks } from './staleLocks';
import { queueRuntime, queueTasks } from './worker';

/** The database schema the queue keeps its tables in, apart from the app's. */
export const QUEUE_SCHEMA = 'queues';

/** Jobs run side by side; work on one Thread still serializes on its own lock. */
const CONCURRENT_JOBS = 4;

let active: { runner: Runner; utils: WorkerUtils; stopSweep: () => void } | null = null;

/**
 * Installs or upgrades the queue's schema, then starts working every task
 * the deployment runs in this process. Jobs already waiting run from here
 * on, and so do those a crashed worker left half done, once their lock
 * is old enough to count as abandoned. Jobs of a task the deployment does
 * not run stay queued, untouched, until it does.
 */
export async function startQueue({ memory }: { memory: MemoryFeature }): Promise<void> {
  if (active) return;
  const utils = await makeWorkerUtils({
    connectionString: env.DATABASE_URL,
    schema: QUEUE_SCHEMA,
  });
  await utils.migrate();
  const stopSweep = keepReleasingStaleLocks(utils);
  const runtime = queueRuntime(queueTasks(memory), utils);
  const runner = await run({
    connectionString: env.DATABASE_URL,
    schema: QUEUE_SCHEMA,
    concurrency: CONCURRENT_JOBS,
    noHandleSignals: true,
    taskList: runtime.taskList,
    events: runtime.events,
    logger: runtime.logger,
  });
  active = { runner, utils, stopSweep };
}

/** Lets running jobs finish, within the engine's grace period, then stops the worker. */
export async function stopQueue(): Promise<void> {
  if (!active) return;
  const { runner, utils, stopSweep } = active;
  active = null;
  stopSweep();
  await runner.stop();
  await utils.release();
}
