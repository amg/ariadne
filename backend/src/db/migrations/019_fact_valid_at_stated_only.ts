import { type Kysely, sql } from 'kysely';

/**
 * A Fact's `valid_at` holds only a date the conversation states for it;
 * null means none was stated. Until now an unstated date fell back to the
 * source message's timestamp, which made the two indistinguishable.
 *
 * Existing rows are told apart by shape: a stated date is always stored
 * at midnight, a message timestamp practically never is.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('user_facts')
    .alterColumn('valid_at', (col) => col.dropNotNull())
    .execute();
  // DML backfill: clear every fallback (non-midnight) timestamp.
  await sql`
    update user_facts set valid_at = null where valid_at <> date_trunc('day', valid_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // DML backfill: an unstated date falls back to when the Fact was stored.
  await sql`update user_facts set valid_at = created_at where valid_at is null`.execute(db);
  await db.schema
    .alterTable('user_facts')
    .alterColumn('valid_at', (col) => col.setNotNull())
    .execute();
}
