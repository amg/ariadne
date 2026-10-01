import { type Kysely, sql } from 'kysely';

/**
 * The two spend surfaces get purpose-built shapes. `message_usage` stays
 * the chat exchange's inference telemetry — it gains `estimated` to mark
 * rows counted locally (the provider never reported usage) and relaxes
 * `provider_id` to nullable, since an estimated row has no provider
 * response id. Token counts and the finish state stay NOT NULL: the
 * estimate path counts both locally and always settles a finish state.
 *
 * The arrival pipeline's rewrite and judge spend moves out of the
 * arrival-embedding rows into their own thin table
 * `message_expansion_costs` (one row per message and step), and those two
 * cost columns drop from `message_embeddings`. The embedding step's
 * spend keeps riding the arrival row as `embedding_cost_usd`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('message_usage')
    .addColumn('estimated', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
  await db.schema
    .alterTable('message_usage')
    .alterColumn('provider_id', (col) => col.dropNotNull())
    .execute();

  await db.schema
    .createTable('message_expansion_costs')
    .addColumn('message_id', 'uuid', (col) =>
      col.references('messages.id').onDelete('cascade').notNull(),
    )
    .addColumn('kind', 'varchar(16)', (col) => col.notNull())
    .addColumn('model', 'varchar(255)', (col) => col.notNull())
    .addColumn('prompt_tokens', 'integer')
    .addColumn('completion_tokens', 'integer')
    .addColumn('cost_usd', sql`numeric(14,10)`, (col) => col.notNull())
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('message_expansion_costs_pkey', ['message_id', 'kind'])
    .execute();
  await sql`
    alter table message_expansion_costs
      add constraint message_expansion_costs_kind_check
      check (kind in ('rewrite', 'judge'))
  `.execute(db);

  // Pour the analyzer's rewrite/judge spend off the arrival rows into the
  // new table. The old columns recorded no model; the environment's fixed
  // pipeline tier is the honest attribution (migrations cannot import the
  // env modules, so the default rides as a literal).
  await sql`
    insert into message_expansion_costs (message_id, kind, model, cost_usd, created_at)
    select message_id, 'rewrite', 'Qwen/Qwen3.5-9B', rewrite_cost_usd, created_at
    from message_embeddings
    where rewrite_cost_usd is not null
  `.execute(db);
  await sql`
    insert into message_expansion_costs (message_id, kind, model, cost_usd, created_at)
    select message_id, 'judge', 'Qwen/Qwen3.5-9B', judge_cost_usd, created_at
    from message_embeddings
    where judge_cost_usd is not null
  `.execute(db);

  await db.schema
    .alterTable('message_embeddings')
    .dropColumn('rewrite_cost_usd')
    .dropColumn('judge_cost_usd')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('message_embeddings')
    .addColumn('rewrite_cost_usd', sql`numeric(14,10)`)
    .addColumn('judge_cost_usd', sql`numeric(14,10)`)
    .execute();
  await sql`
    update message_embeddings me
    set rewrite_cost_usd = c.cost_usd
    from message_expansion_costs c
    where c.message_id = me.message_id and c.kind = 'rewrite'
  `.execute(db);
  await sql`
    update message_embeddings me
    set judge_cost_usd = c.cost_usd
    from message_expansion_costs c
    where c.message_id = me.message_id and c.kind = 'judge'
  `.execute(db);
  await db.schema.dropTable('message_expansion_costs').execute();

  // Lossy: estimated chat rows carry no provider id the old shape demands,
  // so they are discarded first.
  await sql`delete from message_usage where estimated`.execute(db);
  await db.schema
    .alterTable('message_usage')
    .alterColumn('provider_id', (col) => col.setNotNull())
    .execute();
  await db.schema.alterTable('message_usage').dropColumn('estimated').execute();
}
