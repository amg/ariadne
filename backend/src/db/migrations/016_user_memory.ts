import { type Kysely, sql } from 'kysely';

/**
 * User memory: the Fact store, the per-Thread Seed snapshot, per-user
 * settings, and the capture marker on live segments.
 *
 * Facts outlive Threads, so their source message reference nulls out
 * instead of cascading. Segments that closed before this migration are
 * marked captured on the spot: capture starts with segments that close
 * from now on, never backfills.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('user_facts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`uuid_generate_v4()`))
    .addColumn('user_id', 'uuid', (col) => col.references('users.id').onDelete('cascade').notNull())
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('category', 'varchar(32)', (col) => col.notNull())
    .addColumn('subject', 'varchar(255)')
    .addColumn('predicate', 'varchar(255)')
    .addColumn('object', 'varchar(255)')
    .addColumn('embedding', sql`vector(1024)`, (col) => col.notNull())
    .addColumn('model_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('source_message_id', 'uuid', (col) =>
      col.references('messages.id').onDelete('set null'),
    )
    .addColumn('valid_at', 'timestamp', (col) => col.notNull())
    .addColumn('invalid_at', 'timestamp')
    .addColumn('suppressed', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex('user_facts_user_id_idx')
    .on('user_facts')
    .column('user_id')
    .execute();
  // The builder has no access-method or operator-class syntax for an HNSW index.
  await sql`
    create index user_facts_embedding_idx
      on user_facts using hnsw (embedding vector_cosine_ops)
  `.execute(db);

  await db.schema
    .createTable('thread_seeds')
    .addColumn('thread_id', 'uuid', (col) =>
      col.primaryKey().references('threads.id').onDelete('cascade'),
    )
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('fact_count', 'integer', (col) => col.notNull())
    .addColumn('handover_message_id', 'uuid', (col) =>
      col.references('messages.id').onDelete('set null'),
    )
    .addColumn('valid_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('invalid_at', 'timestamp')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('user_settings')
    .addColumn('user_id', 'uuid', (col) =>
      col.primaryKey().references('users.id').onDelete('cascade'),
    )
    .addColumn('settings', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .alterTable('thread_segments')
    .addColumn('facts_captured_at', 'timestamp')
    .execute();
  // DML backfill: segments closed before memory existed are never captured.
  await sql`update thread_segments set facts_captured_at = now()`.execute(db);

  // Check constraints have no builder form.
  await sql`
    alter table message_expansion_costs
      drop constraint message_expansion_costs_kind_check
  `.execute(db);
  await sql`
    alter table message_expansion_costs
      add constraint message_expansion_costs_kind_check
      check (kind in ('rewrite', 'judge', 'fact_extraction', 'fact_dedupe', 'fact_embedding'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    delete from message_expansion_costs
      where kind in ('fact_extraction', 'fact_dedupe', 'fact_embedding')
  `.execute(db);
  await sql`
    alter table message_expansion_costs
      drop constraint message_expansion_costs_kind_check
  `.execute(db);
  await sql`
    alter table message_expansion_costs
      add constraint message_expansion_costs_kind_check
      check (kind in ('rewrite', 'judge'))
  `.execute(db);
  await db.schema.alterTable('thread_segments').dropColumn('facts_captured_at').execute();
  await db.schema.dropTable('user_settings').execute();
  await db.schema.dropTable('thread_seeds').execute();
  await db.schema.dropTable('user_facts').execute();
}
