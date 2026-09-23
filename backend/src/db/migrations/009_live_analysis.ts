import { type Kysely, sql } from 'kysely';

/**
 * Live thread-analysis storage.
 *
 * The live gate persists its arrival signals so that nothing is ever
 * re-embedded or re-judged. Three additions:
 *
 * 1. `message_embeddings` grows the arrival row's vocabulary. The same
 *    table now holds two kinds of rows: *turn* rows keep keying to the
 *    assistant Message (state of the conversation ending there), while
 *    *arrival* rows key to the user Message (the arriving signal judged
 *    before inference). `expanded_text` records the self-contained rewrite
 *    the arrival embedding was taken from (null when the raw message was
 *    embedded); the `*_cost_usd` columns carry this run's per-step spend
 *    and are deliberately never written to `message_usage`.
 * 2. `thread_segments` is the live arrival chain the gate builds as the
 *    conversation progresses — not the fold's segments. A segment end is
 *    the next segment's start (chronology), so no end column.
 * 3. `segment_drift_logs` records one row per judged arrival: the composite
 *    reading judged, the µ/σ/z snapshot of the segment ledger *before* the
 *    arrival joined it, the verdict, and the channel when one fired. Muted
 *    strides log a row with null numbers.
 *
 * Idempotent (`if not exists` / guarded alters): test provisioning replays
 * every migration on a fresh schema.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table message_embeddings
      add column if not exists expanded_text text,
      add column if not exists embedding_cost_usd numeric(14,10),
      add column if not exists rewrite_cost_usd numeric(14,10),
      add column if not exists judge_cost_usd numeric(14,10)
  `.execute(db);

  await sql`
    create table if not exists thread_segments (
      id uuid primary key default uuid_generate_v4(),
      thread_id uuid not null references threads(id) on delete cascade,
      start_message_id uuid not null references messages(id) on delete cascade,
      created_at timestamp not null default now()
    )
  `.execute(db);

  await sql`
    create table if not exists segment_drift_logs (
      id uuid primary key default uuid_generate_v4(),
      segment_id uuid not null references thread_segments(id) on delete cascade,
      message_id uuid not null references messages(id) on delete cascade,
      drift_p double precision,
      mu double precision,
      sigma double precision,
      z_score double precision,
      verdict varchar(10) not null,
      fire_channel varchar(20),
      created_at timestamp not null default now()
    )
  `.execute(db);

  await sql`create index if not exists idx_thread_segments_thread_id
    on thread_segments (thread_id, created_at)`.execute(db);
  await sql`create index if not exists idx_segment_drift_logs_segment_id
    on segment_drift_logs (segment_id, created_at)`.execute(db);
  await sql`create index if not exists idx_segment_drift_logs_message_id
    on segment_drift_logs (message_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists segment_drift_logs`.execute(db);
  await sql`drop table if exists thread_segments`.execute(db);
  await sql`alter table message_embeddings
    drop column if exists judge_cost_usd,
    drop column if exists rewrite_cost_usd,
    drop column if exists embedding_cost_usd,
    drop column if exists expanded_text`.execute(db);
}
