import { type Kysely, sql } from 'kysely';

/**
 * At most one pending reply per Thread. Two Exchanges starting at once,
 * on one backend copy or on two, can then never both run: the second
 * insert finds the first and starts nothing.
 *
 * A Thread already holding several pending rows keeps only its newest
 * pending; the older ones belong to processes long gone and settle as
 * interrupted, as the start of the next Exchange would have settled them.
 * Raw `sql` because the lock and this backfill are statements the schema
 * builder cannot express.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Holds off writers still running on an older backend between the
  // backfill and the index, which would otherwise fail on what they wrote.
  await sql`lock table chat.messages in share row exclusive mode`.execute(db);
  await sql`
    update chat.messages older
       set exchange_status = 'interrupted'
     where older.exchange_status = 'pending'
       and exists (
             select 1
               from chat.messages newer
              where newer.thread_id = older.thread_id
                and newer.exchange_status = 'pending'
                and (newer.created_at, newer.id) > (older.created_at, older.id)
           )
  `.execute(db);

  await db.schema
    .withSchema('chat')
    .createIndex('messages_one_pending_reply_per_thread')
    .on('messages')
    .column('thread_id')
    .unique()
    .where(sql.ref('exchange_status'), '=', 'pending')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.withSchema('chat').dropIndex('messages_one_pending_reply_per_thread').execute();
}
