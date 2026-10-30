import { db } from '@db/db';
import type { DbExecutor } from '@db/types';
import { sql } from 'kysely';

/** A whole line of the queue's own SQL that notifies workers of a new job. */
const NEW_JOB_NOTIFICATION = /^[ \t]*perform pg_notify\('jobs:insert',[^;]*;[ \t]*\n/gm;

/**
 * Stops adding a job to the queue in the schema from notifying workers.
 * A commit that notifies must wait its turn behind every other one that
 * does. Installing or upgrading the queue's schema restores the
 * notification, so call this after each. Processes may call it at the
 * same time, and a schema already done is left as it is. Resolves to the
 * queue functions that still notify, in a form this does not recognise.
 */
export async function silenceJobInserts({ schema }: { schema: string }, executor: DbExecutor = db) {
  return executor.transaction().execute(async (trx) => {
    // Raw SQL: an advisory lock, the catalog and function definitions have no builder.
    await sql`select pg_advisory_xact_lock(hashtext('queue: silence job inserts'))`.execute(trx);
    const { rows } = await sql<{ name: string; definition: string }>`
      select p.oid::regprocedure::text as name, pg_get_functiondef(p.oid) as definition
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ${schema} and p.prosrc like '%pg_notify(''jobs:insert''%'
    `.execute(trx);
    const stillNotifying: string[] = [];
    for (const { name, definition } of rows) {
      const silenced = definition.replace(NEW_JOB_NOTIFICATION, '');
      await sql.raw(silenced).execute(trx);
      if (silenced.includes("pg_notify('jobs:insert'")) stillNotifying.push(name);
    }
    return stillNotifying;
  });
}
