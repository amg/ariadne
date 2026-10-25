import { type Kysely, sql } from 'kysely';

/**
 * Add the source embedding model to the live chain tables.
 *
 * Every stored chain row was evaluated using a specific model's embedding.
 * By keying rows to both the message and the model, changing the model
 * starts a fresh chain instead of mixing calculations from different models,
 * and old chains remain intact until intentionally cleaned up.
 *
 * Existing rows are updated to point to the model that originally produced
 * them: we look up the embedding behind each log and segment. This guarantees
 * there is only one log per (message, model) pair, removing any duplicates
 * created before we started tracking the model source.
 *
 * Idempotent: safe to run multiple times (guarded column adds, safe backfills,
 * unique index creation).
 */
export async function up(db: Kysely<unknown>) {
  await sql`alter table segment_drift_logs add column if not exists model_id text`.execute(db);
  await sql`alter table thread_segments add column if not exists model_id text`.execute(db);

  // Update existing segment_drift_logs with the model_id from their message_embeddings.
  // We use the earliest created_at to resolve any duplicates.
  await sql`
    update segment_drift_logs sd
       set model_id = e.model_id
      from (select distinct on (message_id) message_id, model_id
              from message_embeddings
             order by message_id, created_at) e
     where sd.model_id is null
       and e.message_id = sd.message_id
  `.execute(db);

  // Update existing thread_segments with the model_id from their starting message_embeddings.
  await sql`
    update thread_segments ts
       set model_id = e.model_id
      from (select distinct on (message_id) message_id, model_id
              from message_embeddings
             order by message_id, created_at) e
     where ts.model_id is null
       and e.message_id = ts.start_message_id
  `.execute(db);

  // If there are any stray rows with no matching message_embedding,
  // we fallback to using the most recently used model_id in the database.
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

  // Remove duplicate segment_drift_logs for the same message and model,
  // keeping only the earliest one.
  await sql`
    delete from segment_drift_logs a
     using segment_drift_logs b
     where a.message_id = b.message_id
       and a.model_id = b.model_id
       and (a.created_at, a.id) > (b.created_at, b.id)
  `.execute(db);

  // Replace the old message_id index with a unique index on (message_id, model_id).
  await db.schema.dropIndex('idx_segment_drift_logs_message_id').ifExists().execute();
  await db.schema
    .createIndex('idx_segment_drift_logs_message_model_uq')
    .on('segment_drift_logs')
    .columns(['message_id', 'model_id'])
    .unique()
    .ifNotExists()
    .execute();
}

export async function down(db: Kysely<unknown>) {
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
