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
 * Queues a job. Given a transaction, the job commits or rolls back with
 * the caller's other writes and is as durable as that transaction: pass
 * one whenever losing the job would lose what the caller just stored.
 * Without a transaction the job commits on its own, and the commit returns
 * before it is flushed to disk. A crash in the moments after can then lose
 * it, so the caller must have another way to queue it again.
 *
 * A job for the same task and key that is still waiting is replaced in
 * place, its attempts reset; one already running or dead hands its key
 * over and a fresh job is queued behind it.
 */
export async function enqueueJob<Name extends keyof GraphileWorker.Tasks>(
  { task, payload, key, maxAttempts }: EnqueueJobProps<Name>,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .withPlugin(tagQuery('queue/enqueueJob'))
    .selectNoFrom((eb) => [
      // The setting lasts for the statement's own transaction, so the
      // commit that ends it skips the wait for the flush.
      ...(!executor.isTransaction
        ? [
            eb
              .fn('set_config', [eb.val('synchronous_commit'), eb.val('off'), eb.val(true)])
              .as('commit'),
          ]
        : []),
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
    ])
    .execute();
}
