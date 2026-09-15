import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add cached_rate_multiplier column
  await db.schema.alterTable('model_configs').addColumn('cached_rate_multiplier', 'real').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('model_configs').dropColumn('cached_rate_multiplier').execute();
}
