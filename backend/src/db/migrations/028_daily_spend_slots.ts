import { type Kysely, sql } from 'kysely';

/**
 * Daily spend, in sixteen slots: each UTC day holds up to sixteen rows, and
 * the day's spend is their sum.
 *
 * Spend writers used to share one row per day and waited for each other
 * until their transactions committed. Now each transaction writes to one
 * slot, chosen from its own transaction id. A transaction never holds two
 * slots, so two transactions cannot deadlock on them.
 *
 * The day's existing total moves to slot 0, so the sum is unchanged.
 *
 * A backend that still reads the day as one row sees a single slot until
 * it is replaced, so the new backend should follow this migration at once.
 *
 * The function is raw `sql` because the schema builder cannot express it.
 * Sixteen is written in the function and in the check constraint; change
 * both together.
 */
export async function up(db: Kysely<any>) {
  await db.schema
    .withSchema('billing')
    .alterTable('daily_spend')
    .addColumn('slot', 'smallint', (col) => col.notNull().defaultTo(0))
    .execute();
  await db.schema
    .withSchema('billing')
    .alterTable('daily_spend')
    .dropConstraint('daily_spend_pkey')
    .execute();
  await db.schema
    .withSchema('billing')
    .alterTable('daily_spend')
    .addPrimaryKeyConstraint('daily_spend_pkey', ['day', 'slot'])
    .execute();
  await db.schema
    .withSchema('billing')
    .alterTable('daily_spend')
    .addCheckConstraint('daily_spend_slot_check', sql`slot >= 0 and slot < 16`)
    .execute();

  await sql`
    create or replace function billing.add_daily_spend(amount numeric) returns void
    language sql as $$
      insert into billing.daily_spend as spend (day, slot, cost_usd)
      values ((now() at time zone 'UTC')::date, (txid_current() % 16)::smallint, amount)
      on conflict (day, slot) do update set cost_usd = spend.cost_usd + excluded.cost_usd
    $$
  `.execute(db);
}

export async function down(db: Kysely<any>) {
  // Raw sql: the builder has no table lock. A writer must not commit to a slot between the merge and the delete, or its spend would go with the slots.
  await sql`lock table billing.daily_spend in share row exclusive mode`.execute(db);
  await sql`
    create or replace function billing.add_daily_spend(amount numeric) returns void
    language sql as $$
      insert into billing.daily_spend as spend (day, cost_usd)
      values ((now() at time zone 'UTC')::date, amount)
      on conflict (day) do update set cost_usd = spend.cost_usd + excluded.cost_usd
    $$
  `.execute(db);

  // Each day's total is written to slot 0, which a day may not have yet, before the other slots go.
  await db
    .insertInto('billing.daily_spend')
    .columns(['day', 'slot', 'cost_usd'])
    .expression((eb) =>
      eb
        .selectFrom('billing.daily_spend')
        .select(['day', sql<number>`0`.as('slot'), eb.fn.sum('cost_usd').as('cost_usd')])
        .groupBy('day'),
    )
    .onConflict((oc) =>
      oc.columns(['day', 'slot']).doUpdateSet({ cost_usd: sql.ref('excluded.cost_usd') }),
    )
    .execute();
  await db.deleteFrom('billing.daily_spend').where('slot', '<>', 0).execute();

  await db.schema
    .withSchema('billing')
    .alterTable('daily_spend')
    .dropConstraint('daily_spend_slot_check')
    .execute();
  await db.schema
    .withSchema('billing')
    .alterTable('daily_spend')
    .dropConstraint('daily_spend_pkey')
    .execute();
  await db.schema.withSchema('billing').alterTable('daily_spend').dropColumn('slot').execute();
  await db.schema
    .withSchema('billing')
    .alterTable('daily_spend')
    .addPrimaryKeyConstraint('daily_spend_pkey', ['day'])
    .execute();
}
