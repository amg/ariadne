import type { Kysely } from 'kysely';

/**
 * App tables grouped by the domain that owns them, moved out of
 * `public` into one schema per domain. `public` otherwise holds the
 * auth provider's tables; the queue engine owns its `queues` schema.
 * Moving a table with `set schema` relocates its data, indexes and
 * constraints in one statement; foreign keys keep working across
 * schemas.
 */
const DOMAIN_TABLES = {
  chat: ['users', 'threads', 'messages'],
  analysis: ['message_embeddings', 'thread_segments', 'segment_drift_logs'],
  memory: ['user_facts', 'thread_seeds', 'user_settings', 'memory_capture_progress'],
  billing: ['message_usage', 'message_side_costs', 'model_configs'],
} as const;

const DOMAIN_SCHEMAS = Object.keys(DOMAIN_TABLES);

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const schema of DOMAIN_SCHEMAS) {
    await db.schema.createSchema(schema).ifNotExists().execute();
  }
  for (const [schema, tables] of Object.entries(DOMAIN_TABLES)) {
    for (const table of tables) {
      await db.schema.alterTable(table).setSchema(schema).execute();
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const [schema, tables] of Object.entries(DOMAIN_TABLES)) {
    for (const table of tables) {
      await db.schema.alterTable(`${schema}.${table}`).setSchema('public').execute();
    }
  }
  for (const schema of DOMAIN_SCHEMAS) {
    await db.schema.dropSchema(schema).ifExists().execute();
  }
}
