import { type Kysely, sql } from 'kysely';

/**
 * the architectural decision unit collapse: the embedding unit is the Turn, provenance
 * identity shrinks to `(model_id)`, and the `window_size` discriminator
 * loses its job (frozen at 1 forever — it discriminates nothing). Stored
 * N=2 Window rows are vacated before the column drops: once identity is
 * `(model_id)` alone nothing can tell them apart from Turn vectors, so
 * they must be re-embedded on demand rather than silently compared
 * (every current row is legacy geometry — no Turn vectors exist yet;
 * invalidation rule anticipated exactly this).
 *
 * Idempotent: the delete narrows, the column drop is guarded.
 */
export async function up(db: Kysely<unknown>) {
  await sql`delete from message_embeddings where window_size <> 1`.execute(db);
  await sql`alter table message_embeddings drop column if exists window_size`.execute(db);
}

export async function down(db: Kysely<unknown>) {
  // Restores the 007 column shape; vacated rows stay gone (re-embed on
  // re-analysis).
  await sql`
    alter table message_embeddings
    add column if not exists window_size integer not null default 1
  `.execute(db);
  await sql`alter table message_embeddings alter column window_size drop default`.execute(db);
}
