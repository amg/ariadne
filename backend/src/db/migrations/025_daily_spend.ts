import { type Kysely, sql } from 'kysely';

/**
 * Daily spend: one row per UTC day holding everything recorded as spent
 * that day, across chat, embeddings and side calls, so the daily budget
 * reads one row instead of summing every spend row on each chat.
 *
 * Triggers keep it current from the spend tables themselves, so any
 * writer counts, including ones added later. Spend counts on the day it
 * is recorded, and it stays counted when its messages are deleted.
 *
 * The total is wider than a single spend row, so a busy day can never
 * fail the spend write that pushes it over a row's limit.
 *
 * Raw `sql` for the lock, the trigger functions, the triggers and the
 * backfill, which the schema builder cannot express.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .withSchema('billing')
    .createTable('daily_spend')
    .addColumn('day', 'date', (col) => col.primaryKey())
    .addColumn('cost_usd', sql`numeric(20,10)`, (col) => col.notNull())
    .execute();

  await sql`
    create function billing.add_daily_spend(amount numeric) returns void
    language sql as $$
      insert into billing.daily_spend as spend (day, cost_usd)
      values ((now() at time zone 'UTC')::date, amount)
      on conflict (day) do update set cost_usd = spend.cost_usd + excluded.cost_usd
    $$
  `.execute(db);

  // Two trigger functions because the spend column is named differently.
  await sql`
    create function billing.count_cost_usd() returns trigger
    language plpgsql as $$
    declare
      added numeric := coalesce(new.cost_usd, 0)
        - case when tg_op = 'UPDATE' then coalesce(old.cost_usd, 0) else 0 end;
    begin
      if added <> 0 then
        perform billing.add_daily_spend(added);
      end if;
      return null;
    end
    $$
  `.execute(db);
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

  // Holds off writers still running on an older backend between the
  // backfill and the triggers, whose spend would otherwise go uncounted.
  await sql`
    lock table billing.message_usage, billing.message_side_costs, analysis.message_embeddings
    in share row exclusive mode
  `.execute(db);

  await sql`
    insert into billing.daily_spend (day, cost_usd)
    select day, sum(cost_usd)
      from (
        select created_at::date as day, cost_usd from billing.message_usage
        union all
        select created_at::date, cost_usd from billing.message_side_costs
        union all
        select created_at::date, embedding_cost_usd from analysis.message_embeddings
         where embedding_cost_usd is not null
      ) as spend
     group by day
  `.execute(db);

  await sql`
    create trigger count_daily_spend
    after insert or update of cost_usd on billing.message_usage
    for each row execute function billing.count_cost_usd()
  `.execute(db);
  await sql`
    create trigger count_daily_spend
    after insert or update of cost_usd on billing.message_side_costs
    for each row execute function billing.count_cost_usd()
  `.execute(db);
  await sql`
    create trigger count_daily_spend
    after insert or update of embedding_cost_usd on analysis.message_embeddings
    for each row execute function billing.count_embedding_cost_usd()
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger count_daily_spend on analysis.message_embeddings`.execute(db);
  await sql`drop trigger count_daily_spend on billing.message_side_costs`.execute(db);
  await sql`drop trigger count_daily_spend on billing.message_usage`.execute(db);
  await sql`drop function billing.count_embedding_cost_usd()`.execute(db);
  await sql`drop function billing.count_cost_usd()`.execute(db);
  await sql`drop function billing.add_daily_spend(numeric)`.execute(db);
  await db.schema.withSchema('billing').dropTable('daily_spend').execute();
}
