import type { Kysely } from 'kysely';

/**
 * Assistant rows are inserted empty before their exchange streams and
 * only receive content when the exchange settles. Until now nothing
 * recorded whether an empty row was still running or stranded by a lost
 * process, so concurrent submits against a running thread could not be
 * told apart from recovery retries after a stop.
 *
 * `exchange_status` carries the exchange lifecycle on the assistant row:
 * `pending` while the stream runs, flipped to a terminal state
 * (`completed`, `interrupted`, `error`) when it settles. The completed
 * default backfills every existing assistant row — they all represented
 * finished exchanges at the moment this column landed.
 */
export async function up(db: Kysely<unknown>) {
  await db.schema
    .alterTable('messages')
    .addColumn('exchange_status', 'varchar(16)', (col) => col.notNull().defaultTo('completed'))
    .execute();
}

export async function down(db: Kysely<unknown>) {
  await db.schema.alterTable('messages').dropColumn('exchange_status').execute();
}
