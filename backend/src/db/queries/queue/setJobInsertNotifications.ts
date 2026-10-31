import { db } from '@db/db';
import type { DbExecutor } from '@db/types';
import { sql } from 'kysely';

/** Leads a line of the queue's own SQL whose new-job notification is switched off. */
const OFF_MARK = '-- new-job notification off: ';
/** A whole line that notifies workers of a new job; the indent is kept apart. */
const NOTIFYING_LINE = /^([ \t]*)(perform pg_notify\('jobs:insert',[^;]*;)/gm;
/** A whole line whose notification is switched off; the indent is kept apart. */
const SWITCHED_OFF_LINE = new RegExp(
  `^([ \\t]*)${OFF_MARK}(perform pg_notify\\('jobs:insert',[^;]*;)`,
  'gm',
);

/**
 * Sets whether adding a job to the queue in the schema notifies workers. A
 * commit that notifies must wait its turn behind every other one that
 * does, so a busy queue leaves notifications off and its workers poll.
 * Installing or upgrading the queue's schema turns them back on, so call
 * this after each. Processes may call it at the same time, and a schema
 * already in the asked-for state is left as it is. Resolves to the queue
 * functions that still notify after notifications were turned off, written
 * in a form this does not recognise.
 */
export async function setJobInsertNotifications(
  { schema, notify }: { schema: string; notify: boolean },
  executor: DbExecutor = db,
) {
  return executor.transaction().execute(async (trx) => {
    // Raw SQL: an advisory lock, the catalog and function definitions have no builder.
    await sql`select pg_advisory_xact_lock(hashtext('queue: new-job notifications'))`.execute(trx);
    const { rows } = await sql<{ name: string; definition: string }>`
      select p.oid::regprocedure::text as name, pg_get_functiondef(p.oid) as definition
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ${schema} and p.prosrc like '%pg_notify(''jobs:insert''%'
    `.execute(trx);
    const stillNotifying: string[] = [];
    for (const { name, definition } of rows) {
      const switched = notify
        ? definition.replace(SWITCHED_OFF_LINE, '$1$2')
        : definition.replace(NOTIFYING_LINE, `$1${OFF_MARK}$2`);
      if (switched !== definition) await sql.raw(switched).execute(trx);
      const live = switched.replace(SWITCHED_OFF_LINE, '');
      if (!notify && live.includes("pg_notify('jobs:insert'")) stillNotifying.push(name);
    }
    return stillNotifying;
  });
}
