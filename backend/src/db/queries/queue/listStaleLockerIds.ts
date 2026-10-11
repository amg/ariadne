import { db } from '@db/db';
import { sql } from 'kysely';

/**
 * The workers whose every held job was locked at least `olderThanSeconds`
 * ago, each named once. A worker that took a job within that time is not
 * named, even if it also holds older ones.
 */
export async function listStaleLockerIds({
  olderThanSeconds,
}: {
  olderThanSeconds: number;
}): Promise<string[]> {
  const rows = await db
    .selectFrom('queues.jobs')
    .select('lockedBy')
    .where('lockedBy', 'is not', null)
    .groupBy('lockedBy')
    .having(
      (eb) => eb.fn.max('lockedAt'),
      '<',
      sql<Date>`now() - make_interval(secs => ${olderThanSeconds})`,
    )
    .execute();
  return rows.flatMap((row) => (row.lockedBy === null ? [] : [row.lockedBy]));
}
