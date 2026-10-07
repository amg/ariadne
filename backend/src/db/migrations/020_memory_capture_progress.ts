import { type Kysely, sql } from 'kysely';

/**
 * Segment capture progress moves out of `thread_segments` (which is
 * segmentation's table) and into Memory's own progress table: one row per
 * captured segment, recording how far its Facts were read.
 *
 * The old done/not-done flag is dropped: it meant "some pass settled"
 * whether or not it recorded anything. The new pointer starts undecided,
 * so the first capture pass may re-read turns it read before (the
 * duplicate check keeps them from landing twice).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('memory_capture_progress')
    .addColumn('segment_id', 'uuid', (col) => col.primaryKey())
    .addColumn('captured_through_at', 'timestamptz', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`
    alter table memory_capture_progress
      add constraint memory_capture_progress_segment_fk
      foreign key (segment_id) references thread_segments (id) on delete cascade
  `.execute(db);
  await db.schema.alterTable('thread_segments').dropColumn('facts_captured_at').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('memory_capture_progress').execute();
  await db.schema
    .alterTable('thread_segments')
    .addColumn('facts_captured_at', 'timestamp')
    .execute();
  await sql`update thread_segments set facts_captured_at = now()`.execute(db);
}
