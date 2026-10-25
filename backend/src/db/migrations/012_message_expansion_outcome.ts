import { type Kysely, sql } from 'kysely';

/**
 * The message transformer writes the arrival row in two steps: the rewrite
 * step records the expansion outcome (and its costs) when it finishes,
 * the embed step fills the judged vector into the same row after. The row
 * therefore exists before its vector does — `embedding` relaxes to
 * nullable, and any consumer that needs the vector must find it present
 * (provenance alone no longer proves the row complete). Turn rows are
 * still born with their vector, so only arrival rows ever carry nulls.
 *
 * `expand_outcome` records the end of the arrival's try at a rewrite:
 * `accepted` — the self-contained reading landed; `failed_refused`,
 * `failed_quality`, `failed_inference`, `failed` — it did not, and why;
 * null — no rewrite was attempted and the raw message stands on its own.
 *
 * The typed schema builder carries the DDL; once-only application comes
 * from the tracked Migrator (test provisioning rebuilds the schema fresh
 * each run and replays the whole stack).
 */
export async function up(db: Kysely<unknown>) {
  await db.schema
    .alterTable('message_embeddings')
    .addColumn('expand_outcome', sql`varchar(24)`)
    .alterColumn('embedding', (col) => col.dropNotNull())
    .execute();
}

export async function down(db: Kysely<unknown>) {
  await db.schema
    .alterTable('message_embeddings')
    .dropColumn('expand_outcome')
    .alterColumn('embedding', (col) => col.setNotNull())
    .execute();
}
