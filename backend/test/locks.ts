import { db } from '@db/db';
import { sql } from 'kysely';

/** Resolves once a session of this test database waits on a row lock. */
export async function someoneWaitsOnALock(): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    // The activity view sits outside the typed schema.
    const { rows } = await sql<{ waiting: number }>`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`.execute(db);
    if ((rows[0]?.waiting ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error('nobody ever waited on the lock');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
