import { db } from '@db/db';
import type { QueueJobsView } from '@db/types';
import { type JobErrorClass, jobErrorClassOrNull, jobKeyOf } from './jobError';

/**
 * Where a job stands. `queued` covers a job waiting for its first run and
 * one waiting out the pause before its next attempt; `dead` means it has
 * no attempts left.
 */
export type JobState = 'queued' | 'running' | 'dead';

export interface QueuedJob {
  id: string;
  state: JobState;
  /** The class of the last failure; null while the job has not failed. */
  errorClass: JobErrorClass | null;
  lastError: string | null;
}

function jobStateOf(job: Pick<QueueJobsView, 'lockedAt' | 'attempts' | 'maxAttempts'>): JobState {
  if (job.lockedAt !== null) return 'running';
  return job.attempts >= job.maxAttempts ? 'dead' : 'queued';
}

/**
 * The job a task holds for a key, or null when there is none: never
 * queued, or finished successfully (a finished job leaves no row).
 */
export async function findJobByKeyOrNull({
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
