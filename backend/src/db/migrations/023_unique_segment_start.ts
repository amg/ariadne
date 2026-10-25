import { type Kysely, sql } from 'kysely';

/**
 * One live-chain segment per Thread, start message and embedding model.
 * Two passes over one Thread can then never both open the same segment:
 * the second insert collides, and its pass knows it lost.
 *
 * Duplicates written before the rule existed fold into the oldest row of
 * their group: verdicts judged into a duplicate move to it, and so does
 * the furthest capture pointer of the group. Raw `sql` because these are
 * DML backfills the schema builder cannot express.
 */
const DUPLICATES = sql`
  duplicates as (
    select id, survivor_id
      from (
        select id, first_value(id) over (
                 partition by thread_id, start_message_id, model_id
                 order by created_at, id
               ) as survivor_id
          from analysis.thread_segments
      ) ranked
     where id <> survivor_id
  )
`;

export async function up(db: Kysely<unknown>) {
  // The migrator wraps this in one READ COMMITTED transaction, so each
  // statement below sees a fresh snapshot. Without this lock, an older
  // backend still running while the migration applies could write a
  // drift log or a capture-progress update for a duplicate segment
  // between the statements; the delete below would then cascade-drop
  // them. An old pass may sit in inference for a while before it
  // reaches a locked table, so the wait can stretch. EXCLUSIVE still
  // lets readers through. A SHARE ROW EXCLUSIVE lock on thread_segments
  // alone would not do, because the FK check of an insert only asks for
  // ROW SHARE, which it allows.
  await sql`
    lock table analysis.thread_segments,
               analysis.segment_drift_logs,
               memory.memory_capture_progress
      in exclusive mode
  `.execute(db);
  await sql`
    with ${DUPLICATES}
    update analysis.segment_drift_logs l
       set segment_id = d.survivor_id
      from duplicates d
     where l.segment_id = d.id
  `.execute(db);

  await sql`
    with ${DUPLICATES}
    insert into memory.memory_capture_progress (segment_id, captured_through_at)
    select d.survivor_id, max(p.captured_through_at)
      from duplicates d
      join memory.memory_capture_progress p on p.segment_id = d.id
     group by d.survivor_id
    on conflict (segment_id) do update
       set captured_through_at = greatest(
             memory.memory_capture_progress.captured_through_at,
             excluded.captured_through_at
           ),
           updated_at = now()
  `.execute(db);

  await sql`
    with ${DUPLICATES}
    delete from analysis.thread_segments t
     using duplicates d
     where t.id = d.id
  `.execute(db);

  await db.schema
    .withSchema('analysis')
    .createIndex('thread_segments_thread_start_model_uq')
    .on('thread_segments')
    .columns(['thread_id', 'start_message_id', 'model_id'])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>) {
  await db.schema
    .withSchema('analysis')
    .dropIndex('thread_segments_thread_start_model_uq')
    .execute();
}
