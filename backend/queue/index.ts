import { env } from '@config/env';
import { queuePoolSize } from '@db/poolSize';
import { type Runner, type WorkerUtils, makeWorkerUtils, run } from 'graphile-worker';
import { Pool } from 'pg';
import { logger } from '../src/logger';
import { keepReleasingStaleLocks } from './staleLocks';
import { queueRuntime, queueTasks } from './worker';

/** The database schema the queue keeps its tables in, apart from the app's. */
export const QUEUE_SCHEMA = 'queues';

/**
 * How long a fetched job may wait in its worker before it goes back to the
 * queue. It is well under a stale lock, so the stale-lock sweep never frees
 * a job that a live worker still holds.
 */
const FETCHED_JOB_TTL_MS = 60_000;

/**
 * How long a finished job waits for others to finish, so that they leave
 * the queue in one commit. A failed job is recorded at once, so that a job
 * that gave up never reads as still running.
 */
const FINISHED_JOBS_BATCH_MS = 250;

let active: {
  runner: Runner;
  pool: Pool;
  utils: WorkerUtils;
  stopSweep: () => void;
} | null = null;

/**
 * Installs or upgrades the queue's schema, then starts working every task
 * the deployment runs in this process. Jobs already waiting run from here
 * on, and so do those a crashed worker left half done, once their lock
 * is old enough to count as abandoned. Jobs of a task the deployment does
 * not run stay queued, untouched, until it does. Jobs run side by side,
 * up to the worker's job concurrency; work on one Thread still serializes
 * on its own lock. A worker fetches up to as many jobs as it runs at once
 * in one query, and finished jobs leave the queue together.
 *
 * The engine works through a pool of its own, whose commits return before
 * they are flushed to disk. A crash can then lose the engine's latest
 * bookkeeping: a job it fetched goes back to waiting, and one it finished
 * runs again. Tasks write through the app's pool, whose commits are
 * flushed before they return.
 */
export async function startQueue({ memory, threadAnalysisMode }: Parameters<typeof queueTasks>[0]) {
  if (active) return;
  const utils = await makeWorkerUtils({
    connectionString: env.DATABASE_URL,
    schema: QUEUE_SCHEMA,
  });
  await utils.migrate();
  const stopSweep = keepReleasingStaleLocks(utils);
  const runtime = queueRuntime(queueTasks({ memory, threadAnalysisMode }), utils);
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: queuePoolSize(env.WORKER_JOB_CONCURRENCY),
    options: '-c synchronous_commit=off',
  });
  // A connection the server drops must not crash the process, idle or checked out.
  const logConnectionError = (error: Error) =>
    logger.error({ err: error }, 'queue pool connection failed');
  pool.on('error', logConnectionError);
  pool.on('connect', (client) => client.on('error', logConnectionError));
  const runner = await run({
    pgPool: pool,
    schema: QUEUE_SCHEMA,
    concurrency: env.WORKER_JOB_CONCURRENCY,
    noHandleSignals: true,
    preset: {
      worker: {
        localQueue: { size: env.WORKER_JOB_CONCURRENCY, ttl: FETCHED_JOB_TTL_MS },
        completeJobBatchDelay: FINISHED_JOBS_BATCH_MS,
      },
    },
    taskList: runtime.taskList,
    events: runtime.events,
    logger: runtime.logger,
  });
  active = { runner, pool, utils, stopSweep };
}

/** Lets running jobs finish, within the engine's grace period, then stops the worker. */
export async function stopQueue() {
  if (!active) return;
  const { runner, pool, utils, stopSweep } = active;
  active = null;
  stopSweep();
  await runner.stop();
  await pool.end();
  await utils.release();
}
