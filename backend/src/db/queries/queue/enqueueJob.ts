import type { DbExecutor } from '@db/types';
import { jobKeyOf } from './jobError';

export type EnqueueJobProps = {
  /** The task that runs the job. */
  task: string;
  payload: Record<string, unknown>;
  /** What the job works on; a second job for the same key merges into a waiting one. */
  key: string;
  maxAttempts: number;
};

/**
 * Queues a job on the given handle, so it commits or rolls back with the
 * caller's other writes. A job for the same task and key that is still
 * waiting is replaced in place, its attempts reset; one already running or
 * dead hands its key over and a fresh job is queued behind it.
 */
export async function enqueueJob(
  executor: DbExecutor,
  { task, payload, key, maxAttempts }: EnqueueJobProps,
): Promise<void> {
  await executor
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
