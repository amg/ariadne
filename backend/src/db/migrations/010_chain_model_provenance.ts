import { type Kysely, sql } from 'kysely';

/**
 * Provenance the live chain by its embedding model — the same identity
 * the embedding rows already carry. Every stored chain row was judged on
 * one model's geometry; keying rows to (arrival, model) means a model
 * change starts a fresh parallel chain from the walk instead of bending
 * around the old model's rows, and retired chains stay intact until
 * pruned deliberately.
 *
 * Existing rows backfill the model that produced their reading: the
 * arrival embedding behind each log, the opening arrival's embedding
 * behind each segment. The one-row-per-arrival invariant then holds
 * per (message, model) — the arrival log's identity — so overlapped
 * walks that wrote duplicates of the pre-provenance chain collapse to
 * their earliest judgment too.
 *
 * Idempotent (guarded column adds; the backfill narrows `null`s only;
 * the delete is a no-op on a clean chain; the index swap guarded).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table segment_drift_logs add column if not exists model_id text`.execute(db);
  await sql`alter table thread_segments add column if not exists model_id text`.execute(db);

  // A correlated self-compare (keep the earliest (created_at, id) per
  // (message, model)) has no readable builder shape, so the collapse
  // stays raw like every other storage vacating.
  await sql`
    update segment_drift_logs sd
       set model_id = e.model_id
      from (select distinct on (message_id) message_id, model_id
              from message_embeddings
             order by message_id, created_at) e
     where sd.model_id is null
       and e.message_id = sd.message_id
  `.execute(db);
  await sql`
    update thread_segments ts
       set model_id = e.model_id
      from (select distinct on (message_id) message_id, model_id
              from message_embeddings
             order by message_id, created_at) e
     where ts.model_id is null
       and e.message_id = ts.start_message_id
  `.execute(db);

  // Strays with no arrival embedding left to testify — their model is the
  // store's own latest emission. On a fresh schema there is no log and no
  // embedding, so this and the `not null` below both no-op.
  await sql`
    update segment_drift_logs
       set model_id = newest.model_id
      from (select model_id from message_embeddings order by created_at desc limit 1) newest
     where segment_drift_logs.model_id is null
  `.execute(db);
  await sql`
    update thread_segments
       set model_id = newest.model_id
      from (select model_id from message_embeddings order by created_at desc limit 1) newest
     where thread_segments.model_id is null
  `.execute(db);

  await sql`alter table segment_drift_logs alter column model_id set not null`.execute(db);
  await sql`alter table thread_segments alter column model_id set not null`.execute(db);

  await sql`
    delete from segment_drift_logs a
     using segment_drift_logs b
     where a.message_id = b.message_id
       and a.model_id = b.model_id
       and (a.created_at, a.id) > (b.created_at, b.id)
  `.execute(db);

  await db.schema.dropIndex('idx_segment_drift_logs_message_id').ifExists().execute();
  await db.schema
    .createIndex('idx_segment_drift_logs_message_model_uq')
    .on('segment_drift_logs')
    .columns(['message_id', 'model_id'])
    .unique()
    .ifNotExists()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('idx_segment_drift_logs_message_model_uq').ifExists().execute();
  await db.schema
    .createIndex('idx_segment_drift_logs_message_id')
    .on('segment_drift_logs')
    .column('message_id')
    .ifNotExists()
    .execute();
  await db.schema.alterTable('segment_drift_logs').dropColumn('model_id').execute();
  await db.schema.alterTable('thread_segments').dropColumn('model_id').execute();
}
