import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('model_configs')
    .ifNotExists()
    .addColumn('model_id', 'text', (col) => col.primaryKey())
    .addColumn('provider', 'text', (col) => col.notNull().defaultTo('deepinfra'))
    .addColumn('context_window', 'integer')
    .addColumn('input_price_per_million', 'real')
    .addColumn('output_price_per_million', 'real')
    .addColumn('cached_rate_multiplier', 'real') // multiplier of input price (e.g., 0.5 = 50%)
    .addColumn('supports_caching', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('last_updated', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('model_configs').ifExists().execute();
}
