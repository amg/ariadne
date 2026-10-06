import { db } from '@db/db';

/** The workers holding a job right now, each named once. */
export async function listLockingWorkerIds(): Promise<string[]> {
  const rows = await db
    .selectFrom('queues.jobs')
    .select('lockedBy')
    .distinct()
    .where('lockedBy', 'is not', null)
    .execute();
  return rows.flatMap((row) => (row.lockedBy === null ? [] : [row.lockedBy]));
}
