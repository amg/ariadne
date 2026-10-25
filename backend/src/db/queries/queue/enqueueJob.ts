import { db } from '@db/db';
import { tagQuery } from '@db/queryTag';
import type { DbExecutor } from '@db/types';
import { jobKeyOf } from './jobError';

/** The task that runs the job, and the payload registered for it. */
type EnqueueJobProps<Name extends keyof GraphileWorker.Tasks> = {
  task: Name;
  payload: GraphileWorker.Tasks[Name];
  /** What the job works on; a second job for the same key merges into a waiting one. */
  key: string;
  maxAttempts: number;
};

/**
 * Queues a job; given a transaction, the job commits or rolls back with
 * the caller's other writes. A job for the same task and key that is still
 * waiting is replaced in place, its attempts reset; one already running or
 * dead hands its key over and a fresh job is queued behind it.
 */
export async function enqueueJob<Name extends keyof GraphileWorker.Tasks>(
  { task, payload, key, maxAttempts }: EnqueueJobProps<Name>,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .withPlugin(tagQuery('queue/enqueueJob'))
    .selectNoFrom((eb) =>
      eb
        .fn('queues.add_job', [
          eb.val(task),
          eb.cast(eb.val(JSON.stringify(payload)), 'json'),
          eb.lit(null),
          eb.lit(null),
          eb.val(maxAttempts),
          eb.val(jobKeyOf(task, key)),
        ])
        .as('job'),
    )
    .execute();
}
