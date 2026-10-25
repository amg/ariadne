import { type Kysely, sql } from 'kysely';

/**
 * The analysis schema's final keys.
 *
 * `message_expansions` takes over the rewrite step's columns, so
 * `message_embeddings` keeps only proven vectors: one row per Message
 * and embedding model, the vector NOT NULL. The arrival pipeline's
 * embedding spend moves to `message_side_costs` under a new `embedding`
 * kind, and that table's key widens by the model so several models can
 * hold spend for one Message. Half-finished arrival rows — outcome
 * stored, vector never filled — are deleted: the expansions table keeps
 * their reading, the re-run re-embeds only the vector. And
 * `segment_drift_logs` drops its surrogate id: one verdict per Message
 * and model is the key.
 *
 * Daily spend stays exact through the move. The embeddings trigger is
 * dropped and the side-cost trigger suspended while the spend pours into
 * its new rows (the daily total already holds it); both live again per
 * the new shape once the pour is done. Writers still running on an
 * older backend are held off for the whole dance (025's pattern), so
 * nothing lands uncounted in between.
 *
 * Migrations reshape the schema the app's Database type never models, so
 * they ride the untyped connection Kysely's own Migrator hands them
 * (mid-migration shapes carry no app-side type, in any spelling). The
 * table lock, the trigger and function surgery and the trigger holds
 * have no builder; everything else — the constraint surgery and the
 * pours — is typed builder DDL/DML.
 */

export async function up(db: Kysely<any>) {
  // 1. The rewrite step's table, poured out of the arrival rows that
  //    carried it. Untried rewrites read back as `not_needed`.
  await db.schema
    .withSchema('analysis')
    .createTable('message_expansions')
    .addColumn('message_id', 'uuid', (col) =>
      col.references('chat.messages.id').onDelete('cascade').notNull(),
    )
    .addColumn('expand_outcome', 'varchar(24)', (col) => col.notNull())
    .addColumn('expanded_text', 'text')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('message_expansions_pkey', ['message_id'])
    .addCheckConstraint(
      'message_expansions_outcome_check',
      sql`expand_outcome in ('accepted', 'failed_refused', 'failed_quality', 'failed_inference', 'failed', 'not_needed')`,
    )
    .addCheckConstraint(
      'message_expansions_outcome_text_check',
      sql`(expand_outcome = 'accepted') = (expanded_text is not null)`,
    )
    .execute();
  await db
    .insertInto('analysis.message_expansions')
    .columns(['message_id', 'expand_outcome', 'expanded_text', 'created_at'])
    .expression((eb) =>
      eb
        .selectFrom('analysis.message_embeddings as e')
        .innerJoin('chat.messages as m', (join) => join.onRef('m.id', '=', 'e.message_id'))
        .where('m.role', '=', 'user')
        .select((eb) => [
          'e.message_id as message_id',
          eb.fn
            .coalesce(
              eb.ref('e.expand_outcome'),
              eb
                .case()
                .when(eb('e.expanded_text', 'is not', null))
                .then('accepted')
                .else('not_needed')
                .end(),
            )
            .as('expand_outcome'),
          'e.expanded_text as expanded_text',
          'e.created_at as created_at',
        ]),
    )
    .onConflict((oc) => oc.column('message_id').doNothing())
    .execute();

  // 2. Embedding spend moves to the side-cost table. The lock holds
  //    older-backend writers off for the whole dance (025's pattern).
  await sql`
    lock table analysis.message_embeddings, billing.message_side_costs
      in share row exclusive mode
  `.execute(db);
  await sql`drop trigger count_daily_spend on analysis.message_embeddings`.execute(db);
  await sql`drop function billing.count_embedding_cost_usd()`.execute(db);
  await db.schema
    .withSchema('billing')
    .alterTable('message_side_costs')
    .dropConstraint('message_side_costs_kind_check')
    .execute();
  await db.schema
    .withSchema('billing')
    .alterTable('message_side_costs')
    .addCheckConstraint(
      'message_side_costs_kind_check',
      sql`kind in ('rewrite', 'judge', 'fact_extraction', 'fact_duplicate_check', 'fact_embedding', 'embedding')`,
    )
    .execute();
  await db.schema
    .withSchema('billing')
    .alterTable('message_side_costs')
    .dropConstraint('message_side_costs_pkey')
    .execute();
  await db.schema
    .withSchema('billing')
    .alterTable('message_side_costs')
    .addPrimaryKeyConstraint('message_side_costs_pkey', ['message_id', 'kind', 'model'])
    .execute();
  // Daily spend already holds these amounts, so its trigger stays off
  // until the pour is done.
  await sql`alter table billing.message_side_costs disable trigger count_daily_spend`.execute(db);
  await db
    .insertInto('billing.message_side_costs')
    .columns(['message_id', 'kind', 'model', 'cost_usd', 'created_at'])
    .expression((eb) =>
      eb
        .selectFrom('analysis.message_embeddings')
        .where('embedding_cost_usd', 'is not', null)
        .select((eb) => [
          'message_id as message_id',
          eb.val('embedding').as('kind'),
          'model_id as model',
          'embedding_cost_usd as cost_usd',
          'created_at as created_at',
        ]),
    )
    .onConflict((oc) => oc.columns(['message_id', 'kind', 'model']).doNothing())
    .execute();
  await sql`alter table billing.message_side_costs enable trigger count_daily_spend`.execute(db);

  // 3. Only proven vectors stay.
  await db.deleteFrom('analysis.message_embeddings').where('embedding', 'is', null).execute();
  await db.schema
    .withSchema('analysis')
    .alterTable('message_embeddings')
    .alterColumn('embedding', (col) => col.setNotNull())
    .dropColumn('expanded_text')
    .dropColumn('expand_outcome')
    .dropColumn('embedding_cost_usd')
    .execute();
  await db.schema
    .withSchema('analysis')
    .alterTable('message_embeddings')
    .dropConstraint('message_embeddings_pkey')
    .execute();
  await db.schema
    .withSchema('analysis')
    .alterTable('message_embeddings')
    .addPrimaryKeyConstraint('message_embeddings_pkey', ['message_id', 'model_id'])
    .execute();

  // 4. One verdict per Message and model — the surrogate id goes.
  await db.schema
    .withSchema('analysis')
    .alterTable('segment_drift_logs')
    .dropConstraint('segment_drift_logs_pkey')
    .execute();
  await db.schema
    .withSchema('analysis')
    .dropIndex('idx_segment_drift_logs_message_model_uq')
    .execute();
  await db.schema
    .withSchema('analysis')
    .alterTable('segment_drift_logs')
    .addPrimaryKeyConstraint('segment_drift_logs_pkey', ['message_id', 'model_id'])
    .execute();
  await db.schema
    .withSchema('analysis')
    .alterTable('segment_drift_logs')
    .dropColumn('id')
    .execute();
}

export async function down(db: Kysely<any>) {
  // 4 reversed: back comes a surrogate id.
  await db.schema
    .withSchema('analysis')
    .alterTable('segment_drift_logs')
    .addColumn('id', 'uuid', (col) => col.notNull().defaultTo(sql`uuid_generate_v4()`))
    .execute();
  await db.schema
    .withSchema('analysis')
    .alterTable('segment_drift_logs')
    .dropConstraint('segment_drift_logs_pkey')
    .execute();
  await db.schema
    .withSchema('analysis')
    .alterTable('segment_drift_logs')
    .addPrimaryKeyConstraint('segment_drift_logs_pkey', ['id'])
    .execute();
  await db.schema
    .withSchema('analysis')
    .createIndex('idx_segment_drift_logs_message_model_uq')
    .on('segment_drift_logs')
    .columns(['message_id', 'model_id'])
    .unique()
    .execute();

  // 3 reversed. Lossy when two models hold the same Message: the
  // earliest row survives, the later provenance is gone. The row-value
  // comparison has no builder literal, so it rides a raw fragment
  // inside the typed delete.
  await db
    .deleteFrom('analysis.message_embeddings as e')
    .using('analysis.message_embeddings as keep')
    .whereRef('e.message_id', '=', 'keep.message_id')
    .where(sql<boolean>`(keep.created_at, keep.model_id) < (e.created_at, e.model_id)`)
    .execute();
  await db.schema
    .withSchema('analysis')
    .alterTable('message_embeddings')
    .dropConstraint('message_embeddings_pkey')
    .execute();
  await db.schema
    .withSchema('analysis')
    .alterTable('message_embeddings')
    .addPrimaryKeyConstraint('message_embeddings_pkey', ['message_id'])
    .execute();
  await db.schema
    .withSchema('analysis')
    .alterTable('message_embeddings')
    .addColumn('expanded_text', 'text')
    .addColumn('expand_outcome', 'varchar(24)')
    .addColumn('embedding_cost_usd', sql`numeric(14,10)`)
    .alterColumn('embedding', (col) => col.dropNotNull())
    .execute();

  // 2 reversed: spend pours back onto the rows it rode, uncounted while
  //    the trigger is missing, then the key narrows by the model. The
  //    function and its trigger have no builder.
  await sql`
    create function billing.count_embedding_cost_usd() returns trigger
    language plpgsql as $$
    declare
      added numeric := coalesce(new.embedding_cost_usd, 0)
        - case when tg_op = 'UPDATE' then coalesce(old.embedding_cost_usd, 0) else 0 end;
    begin
      if added <> 0 then
        perform billing.add_daily_spend(added);
      end if;
      return null;
    end
    $$
  `.execute(db);
  await sql`alter table billing.message_side_costs disable trigger count_daily_spend`.execute(db);
  await db
    .updateTable('analysis.message_embeddings as e')
    .from('billing.message_side_costs as c')
    .set((eb) => ({ embedding_cost_usd: eb.ref('c.cost_usd') }))
    .whereRef('e.message_id', '=', 'c.message_id')
    .whereRef('e.model_id', '=', 'c.model')
    .where('c.kind', '=', 'embedding')
    .execute();
  await db.deleteFrom('billing.message_side_costs').where('kind', '=', 'embedding').execute();
  await sql`alter table billing.message_side_costs enable trigger count_daily_spend`.execute(db);
  await db.schema
    .withSchema('billing')
    .alterTable('message_side_costs')
    .dropConstraint('message_side_costs_pkey')
    .execute();
  await db.schema
    .withSchema('billing')
    .alterTable('message_side_costs')
    .addPrimaryKeyConstraint('message_side_costs_pkey', ['message_id', 'kind'])
    .execute();
  await db.schema
    .withSchema('billing')
    .alterTable('message_side_costs')
    .dropConstraint('message_side_costs_kind_check')
    .execute();
  await db.schema
    .withSchema('billing')
    .alterTable('message_side_costs')
    .addCheckConstraint(
      'message_side_costs_kind_check',
      sql`kind in ('rewrite', 'judge', 'fact_extraction', 'fact_duplicate_check', 'fact_embedding')`,
    )
    .execute();
  await sql`
    create trigger count_daily_spend
    after insert or update of embedding_cost_usd on analysis.message_embeddings
    for each row execute function billing.count_embedding_cost_usd()
  `.execute(db);

  // 1 reversed: outcome and text pour back onto the rows they rode,
  // `not_needed` back to the null it was.
  await db
    .updateTable('analysis.message_embeddings as e')
    .from('analysis.message_expansions as x')
    .set((eb) => ({
      expand_outcome: eb
        .case()
        .when(eb('x.expand_outcome', '=', 'not_needed'))
        .then(null)
        .else(eb.ref('x.expand_outcome'))
        .end(),
      expanded_text: eb.ref('x.expanded_text'),
    }))
    .whereRef('e.message_id', '=', 'x.message_id')
    .execute();
  await db.schema.withSchema('analysis').dropTable('message_expansions').execute();
}
