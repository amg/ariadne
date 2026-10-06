import { env } from '@config/env';
import { db } from '@db/db';
import { type JobErrorClass, jobKeyOf, taggedJobError } from '@queries/queue/jobError';
import { QUEUE_SCHEMA, startQueue, stopQueue } from '@queue/index';
import { queueRuntime } from '@queue/worker';
import type { MemoryFeature } from '@services/memory';
import { type TaskList, makeWorkerUtils, runOnce } from 'graphile-worker';
import { afterAll, afterEach, beforeAll } from 'vitest';

function workerUtils() {
  return makeWorkerUtils({ connectionString: env.DATABASE_URL, schema: QUEUE_SCHEMA });
}

/**
 * Works the given tasks in this process until no job is due, then waits for
 * fatal failures to be marked dead. A job waiting out its retry pause is
 * not due; `makeWaitingJobsDue` brings it forward.
 */
export async function drainQueue(tasks: TaskList): Promise<void> {
  const utils = await workerUtils();
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
  const utils = await workerUtils();
  try {
    await utils.rescheduleJobs(
      waiting.map((job) => job.id),
      { runAt: new Date() },
    );
  } finally {
    await utils.release();
  }
}

/** Leaves a dead job behind for the key, as if every attempt had failed with that class. */
export async function addDeadJob(job: {
  task: string;
  key: string;
  payload: Record<string, unknown>;
  errorClass: JobErrorClass;
}): Promise<void> {
  const utils = await workerUtils();
  try {
    const added = await utils.addJob(job.task, job.payload, {
      jobKey: jobKeyOf(job.task, job.key),
      maxAttempts: 3,
      runAt: new Date(Date.now() + 3_600_000),
    });
    await utils.permanentlyFailJobs([added.id], taggedJobError(job.errorClass, 'test death'));
  } finally {
    await utils.release();
  }
}

/** Resolves once no job is running and none is due, or throws after the time limit. */
async function queueIdle(limitMs = 20_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const busy = await db
      .selectFrom('queues.jobs')
      .select('id')
      .where((eb) =>
        eb.or([
          eb('lockedAt', 'is not', null),
          eb.and([eb('attempts', '<', eb.ref('maxAttempts')), eb('runAt', '<=', new Date())]),
        ]),
      )
      .executeTakeFirst();
    if (!busy) return;
    if (Date.now() > deadline) throw new Error('the queue never went idle');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Runs the app's worker in the test process for the whole file, the way
 * the server does with the given Memory decision, so a request waiting on
 * a task sees it complete. Call after `useTestDb()`: each test's jobs
 * finish before its tables are cleared.
 */
export function useTestQueue({ memory }: { memory: MemoryFeature }): void {
  beforeAll(async () => {
    await startQueue({ memory });
  });
  afterEach(async () => {
    await queueIdle();
  });
  afterAll(async () => {
    await stopQueue();
  });
}
