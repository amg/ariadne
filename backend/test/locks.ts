import { db } from '@db/db';
import type { DbExecutor } from '@db/types';
import { sql } from 'kysely';
import { afterEach } from 'vitest';

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

export type HeldTransaction = { trx: DbExecutor; commit: () => Promise<void> };

/**
 * Lets the suite hold transactions open, standing in for a write caught
 * mid-way; `commit` lets one finish. Any a failed test left open are
 * committed after it, so its locks never stall the next test.
 */
export function useHeldTransactions(): () => Promise<HeldTransaction> {
  const open = new Set<() => Promise<void>>();
  afterEach(async () => {
    await Promise.all([...open].map((commit) => commit()));
  });

  return async () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened: (trx: DbExecutor) => void = () => {};
    const handle = new Promise<DbExecutor>((resolve) => {
      opened = resolve;
    });
    const done = db.transaction().execute(async (trx) => {
      opened(trx);
      await released;
    });
    const commit = async () => {
      open.delete(commit);
      release();
      await done;
    };
    open.add(commit);
    return { trx: await handle, commit };
  };
}
