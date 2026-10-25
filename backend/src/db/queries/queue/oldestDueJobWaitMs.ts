import { db } from '@db/db';
import { tagQuery } from '@db/queryTag';
import { sql } from 'kysely';

/**
 * How long, in milliseconds, the oldest job of the given tasks has been
 * due to run without a worker taking it; 0 when none is waiting. A job
 * waiting out the pause before a retry is not due, and counts for
 * nothing. The wait is measured on the database's own clock. The
 * database gives up on the query after `timeoutMs`, and the call rejects.
 */
export async function oldestDueJobWaitMs({
  tasks,
  timeoutMs,
}: {
  tasks: readonly string[];
  timeoutMs: number;
}) {
  if (tasks.length === 0) return 0;
  const row = await db.transaction().execute(async (trx) => {
    await sql`set local statement_timeout = ${sql.lit(Math.round(timeoutMs))}`.execute(trx);
    return trx
      .withPlugin(tagQuery('queue/oldestDueJobWaitMs'))
      .selectFrom('queues.jobs')
      .select(sql<number | null>`extract(epoch from (now() - min(run_at))) * 1000`.as('waitMs'))
      .where('lockedAt', 'is', null)
      .whereRef('attempts', '<', 'maxAttempts')
      .where('runAt', '<=', sql<Date>`now()`)
      .where('taskIdentifier', 'in', [...tasks])
      .executeTakeFirst();
  });
  return Number(row?.waitMs ?? 0);
}
