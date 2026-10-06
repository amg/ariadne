import { env } from '@config/env';
import { db } from '@db/db';
import { QUEUE_SCHEMA } from '@queue/index';
import { type RegisteredTask, queueRuntime } from '@queue/worker';
import { makeWorkerUtils, runOnce } from 'graphile-worker';

/**
 * Works the given tasks in this process until no job is due, then waits for
 * fatal failures to be marked dead. A job waiting out its retry pause is
 * not due; `makeWaitingJobsDue` brings it forward.
 */
export async function drainQueue(tasks: readonly RegisteredTask[]): Promise<void> {
  const utils = await makeWorkerUtils({ connectionString: env.DATABASE_URL, schema: QUEUE_SCHEMA });
  try {
    const runtime = queueRuntime(tasks, utils);
    await runOnce({
      connectionString: env.DATABASE_URL,
      schema: QUEUE_SCHEMA,
      noHandleSignals: true,
      taskList: runtime.taskList,
      events: runtime.events,
      logger: runtime.logger,
    });
    await runtime.settled();
  } finally {
    await utils.release();
  }
}

/** Makes every job waiting out a retry pause due right now. */
export async function makeWaitingJobsDue(): Promise<void> {
  const waiting = await db
    .selectFrom('queues.jobs')
    .select('id')
    .where('lockedAt', 'is', null)
    .whereRef('attempts', '<', 'maxAttempts')
    .execute();
  if (waiting.length === 0) return;
  const utils = await makeWorkerUtils({ connectionString: env.DATABASE_URL, schema: QUEUE_SCHEMA });
  try {
    await utils.rescheduleJobs(
      waiting.map((job) => job.id),
      { runAt: new Date() },
    );
  } finally {
    await utils.release();
  }
}
