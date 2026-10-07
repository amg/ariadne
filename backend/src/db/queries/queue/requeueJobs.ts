import { db } from '@db/db';

/**
 * Makes the given jobs due now with all their attempts back, dead ones
 * included. A job running right now is left alone. Resolves to the ids it
 * re-queued.
 */
export async function requeueJobs(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom((eb) =>
      eb
        .fn<{ id: string }>('queues.reschedule_jobs', [
          eb.val(ids),
          eb.fn('now'),
          eb.lit(null),
          eb.lit(0),
          eb.lit(null),
        ])
        .as('job'),
    )
    .select('job.id')
    .execute();
  return rows.map((row) => row.id);
}
