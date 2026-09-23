import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('segment_drift_logs')
    .addColumn('slow_drift_start_message_id', 'uuid', (col) =>
      col.references('messages.id').onDelete('set null'),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('segment_drift_logs')
    .dropColumn('slow_drift_start_message_id')
    .execute();
}
