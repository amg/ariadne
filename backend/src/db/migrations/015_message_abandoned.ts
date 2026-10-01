import type { Kysely } from 'kysely';

/**
 * The exchange's arrival message gains an `abandoned` marker: the exchange
 * sets it when it ends without completing, so an interrupted exchange
 * registers in the thread instead of being swallowed (the shared listing
 * picks the thread up via its partial title, the resume-draft reader finds
 * the arrival's text).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('messages')
    .addColumn('abandoned', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('messages').dropColumn('abandoned').execute();
}
