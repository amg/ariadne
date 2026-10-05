import { type Kysely, sql } from 'kysely';

/**
 * Corrections to 016 from the memory review, kept apart so a database that
 * already ran 016 needs no reset.
 *
 * - Seeds keep each line's Fact category (`lines` jsonb), so a category
 *   blocked later drops out of Seeds already frozen. Existing Seeds are
 *   split into lines; each line takes the category of the user's Fact it
 *   renders, or `other` when none matches.
 * - Segments still open owe capture: 016 marked every segment captured,
 *   but one with no live closing fire closes after memory shipped.
 * - The `fact_dedupe` cost kind is renamed `fact_duplicate_check`, which
 *   needs a wider `kind` column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('thread_seeds')
    .addColumn('lines', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .execute();
  // DML backfill: line 1 of the old content is the header, the rest are
  // "- YYYY-MM-DD: <fact>" bullets.
  await sql`
    update thread_seeds s set lines = coalesce((
      select jsonb_agg(
        jsonb_build_object('category', coalesce(f.category, 'other'), 'text', l.line)
        order by l.n
      )
      from unnest(string_to_array(s.content, E'\n')) with ordinality as l(line, n)
      left join lateral (
        select uf.category from user_facts uf
        join threads t on t.user_id = uf.user_id
        where t.id = s.thread_id and right(l.line, length(uf.content)) = uf.content
        limit 1
      ) f on true
      where l.n > 1
    ), '[]'::jsonb)
  `.execute(db);
  await db.schema
    .alterTable('thread_seeds')
    .alterColumn('lines', (col) => col.dropDefault())
    .execute();
  await db.schema.alterTable('thread_seeds').dropColumn('content').execute();

  // DML correction: a segment no live arrival has closed is still open.
  await sql`
    update thread_segments s set facts_captured_at = null
    where facts_captured_at is not null
      and not exists (
        select 1 from segment_drift_logs l
        join messages closer on closer.id = l.message_id
        where l.segment_id = s.id and l.verdict = 'fire' and not closer.abandoned
      )
  `.execute(db);

  // Check constraints have no builder form.
  await sql`
    alter table message_expansion_costs
      drop constraint message_expansion_costs_kind_check
  `.execute(db);
  await db.schema
    .alterTable('message_expansion_costs')
    .alterColumn('kind', (col) => col.setDataType('varchar(32)'))
    .execute();
  await sql`
    update message_expansion_costs set kind = 'fact_duplicate_check' where kind = 'fact_dedupe'
  `.execute(db);
  await sql`
    alter table message_expansion_costs
      add constraint message_expansion_costs_kind_check
      check (kind in ('rewrite', 'judge', 'fact_extraction', 'fact_duplicate_check', 'fact_embedding'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table message_expansion_costs
      drop constraint message_expansion_costs_kind_check
  `.execute(db);
  await sql`
    update message_expansion_costs set kind = 'fact_dedupe' where kind = 'fact_duplicate_check'
  `.execute(db);
  await db.schema
    .alterTable('message_expansion_costs')
    .alterColumn('kind', (col) => col.setDataType('varchar(16)'))
    .execute();
  await sql`
    alter table message_expansion_costs
      add constraint message_expansion_costs_kind_check
      check (kind in ('rewrite', 'judge', 'fact_extraction', 'fact_dedupe', 'fact_embedding'))
  `.execute(db);

  // Reopened segments are not re-marked: capture owed is the safer state.

  await db.schema
    .alterTable('thread_seeds')
    .addColumn('content', 'text', (col) => col.notNull().defaultTo(''))
    .execute();
  // DML backfill: the header is dropped; the bullets keep their order.
  await sql`
    update thread_seeds s set content = coalesce((
      select string_agg(e.line->>'text', E'\n' order by e.n)
      from jsonb_array_elements(s.lines) with ordinality as e(line, n)
    ), '')
  `.execute(db);
  await db.schema
    .alterTable('thread_seeds')
    .alterColumn('content', (col) => col.dropDefault())
    .execute();
  await db.schema.alterTable('thread_seeds').dropColumn('lines').execute();
}
