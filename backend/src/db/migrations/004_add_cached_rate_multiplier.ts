import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>) {
  // Add cached_rate_multiplier column if it isn't there yet. Migration 003
  // (shipped in the same change) already creates it, so a fresh schema
  // replay would otherwise collide — `if not exists` keeps 004 a no-op
  // there while still adding the column on older databases.
  await sql`alter table model_configs add column if not exists cached_rate_multiplier real`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>) {
  await db.schema.alterTable('model_configs').dropColumn('cached_rate_multiplier').execute();
}
