import { db } from '@db/db';
import type { QueueJobsView, QueuedJob } from '@db/types';
import { jobErrorClassOrNull, jobKeyOf } from './jobError';

function jobStateOf(job: Pick<QueueJobsView, 'lockedAt' | 'attempts' | 'maxAttempts'>) {
  if (job.lockedAt !== null) return 'running';
  return job.attempts >= job.maxAttempts ? 'dead' : 'queued';
}

/**
 * The job a task holds for a key, or null when there is none: never
 * queued, or finished successfully (a finished job leaves no row).
 */
export async function findJobByKey({
  task,
  key,
}: {
  task: string;
  key: string;
}): Promise<QueuedJob | null> {
  const row = await db
    .selectFrom('queues.jobs')
    .select(['id', 'lockedAt', 'attempts', 'maxAttempts', 'lastError'])
    .where('key', '=', jobKeyOf(task, key))
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    state: jobStateOf(row),
    errorClass: jobErrorClassOrNull(row.lastError),
    lastError: row.lastError,
  };
}
