import type { Kysely } from 'kysely';

/**
 * Indexes for the foreign keys Postgres left unindexed. The Thread list and
 * each Thread's Messages are read by owner and in creation order, so those
 * two also carry `created_at`. The four keys pointing at a Message are
 * checked on every Message delete, a Thread delete's cascade included.
 */
const INDEXES = [
  {
    schema: 'chat',
    table: 'threads',
    name: 'threads_user_id_created_at_idx',
    columns: ['user_id', 'created_at'],
  },
  {
    schema: 'chat',
    table: 'messages',
    name: 'messages_thread_id_created_at_idx',
    columns: ['thread_id', 'created_at'],
  },
  {
    schema: 'analysis',
    table: 'thread_segments',
    name: 'thread_segments_start_message_id_idx',
    columns: ['start_message_id'],
  },
  {
    schema: 'analysis',
    table: 'segment_drift_logs',
    name: 'segment_drift_logs_slow_drift_start_message_id_idx',
    columns: ['slow_drift_start_message_id'],
  },
  {
    schema: 'memory',
    table: 'user_facts',
    name: 'user_facts_source_message_id_idx',
    columns: ['source_message_id'],
  },
  {
    schema: 'memory',
    table: 'thread_seeds',
    name: 'thread_seeds_handover_message_id_idx',
    columns: ['handover_message_id'],
  },
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const index of INDEXES) {
    await db.schema
      .withSchema(index.schema)
      .createIndex(index.name)
      .on(index.table)
      .columns([...index.columns])
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const index of INDEXES) {
    await db.schema.withSchema(index.schema).dropIndex(index.name).execute();
  }
}
