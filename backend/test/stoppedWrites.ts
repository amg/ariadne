import { db } from '@db/db';
import { sql } from 'kysely';
import { afterEach } from 'vitest';

/**
 * Lets a test stop a task between two of its writes. While a table is
 * stopped, every insert into it fails and rolls its own transaction back,
 * as if the process had died just before that write. Tables left stopped
 * by a failed test are released after it.
 *
 * The trigger is DDL on purpose: only the database can fail a write that
 * the code under test makes through its own queries.
 */
export function useStoppableWrites() {
  const stopped = new Set<string>();

  async function release(table: string) {
    await sql.raw(`drop trigger if exists stop_writes on ${table}`).execute(db);
    stopped.delete(table);
  }

  afterEach(async () => {
    await Promise.all([...stopped].map(release));
  });

  return async (table: `${string}.${string}`) => {
    await sql
      .raw(
        `create or replace function stop_writes() returns trigger language plpgsql as
         $$ begin raise exception 'the task stopped before this write'; end $$`,
      )
      .execute(db);
    await sql
      .raw(
        `create trigger stop_writes before insert on ${table}
         for each row execute function stop_writes()`,
      )
      .execute(db);
    stopped.add(table);
    return () => release(table);
  };
}
