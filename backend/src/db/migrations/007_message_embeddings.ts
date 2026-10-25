import { type Kysely, sql } from 'kysely';

/**
 * Turn embeddings for thread-health drift detection.
 *
 * Semantics: the row keyed to message N holds the TURN embedding of the
 * Turn ending at N — "state of the conversation as of this message",
 * deliberately not a per-message embedding. Provenance is `(model_id)` —
 * vectors from a different embedding model live in incompatible spaces and
 * must be re-embedded, never mixed. pgvector was already installed by
 * migration 001.
 *
 * Idempotent (`if not exists`): test provisioning replays all migrations on
 * a fresh schema.
 */
export async function up(db: Kysely<unknown>) {
  await sql`
    create table if not exists message_embeddings (
      message_id uuid primary key references messages(id) on delete cascade,
      embedding vector(1024) not null,
      model_id varchar(255) not null,
      window_size integer not null,
      created_at timestamp not null default now()
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>) {
  await sql`drop table if exists message_embeddings`.execute(db);
}
