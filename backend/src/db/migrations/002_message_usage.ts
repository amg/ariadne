import { type Kysely, sql } from 'kysely';
/**
 * Per-assistant-message inference telemetry, linked 1:1 to `messages`
 * (see features/ai-connector/MVP.md — "Schema (migration 002_message_usage)").
 *
 * Token columns the provider does not report land as NULL (cache hits/writes
 * and reasoning tokens depend on the model/provider). Columns we always
 * control — prompt/completion counts, cost, finish state — stay NOT NULL.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('message_usage')
    .addColumn('message_id', 'uuid', (col) =>
      col.references('messages.id').onDelete('cascade').notNull(),
    )
    .addColumn('model', 'varchar(255)', (col) => col.notNull())
    .addColumn('provider_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('prompt_tokens', 'integer', (col) => col.notNull())
    .addColumn('completion_tokens', 'integer', (col) => col.notNull())
    .addColumn('cached_input_tokens', 'integer')
    .addColumn('cache_write_tokens', 'integer')
    .addColumn('reasoning_tokens', 'integer')
    .addColumn('cost_usd', sql`numeric(14,10)`, (col) => col.notNull())
    .addColumn('finish_reason', 'varchar(50)', (col) => col.notNull())
    .addColumn('latency_ms', 'integer')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('message_usage_pkey', ['message_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('message_usage').execute();
}
