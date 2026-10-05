import { type Kysely, sql } from 'kysely';

/**
 * `message_expansion_costs` becomes `message_side_costs`: the table logs
 * every billed side call against a message (the drift pipeline's rewrite
 * and judge, and Fact capture), not only the rewrite ("expansion") step.
 * Constraints are renamed with it; the primary key's index follows its
 * constraint.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('message_expansion_costs').renameTo('message_side_costs').execute();
  // Constraint renames have no builder form.
  await sql`
    alter table message_side_costs
      rename constraint message_expansion_costs_pkey to message_side_costs_pkey
  `.execute(db);
  await sql`
    alter table message_side_costs
      rename constraint message_expansion_costs_message_id_fkey to message_side_costs_message_id_fkey
  `.execute(db);
  await sql`
    alter table message_side_costs
      rename constraint message_expansion_costs_kind_check to message_side_costs_kind_check
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table message_side_costs
      rename constraint message_side_costs_kind_check to message_expansion_costs_kind_check
  `.execute(db);
  await sql`
    alter table message_side_costs
      rename constraint message_side_costs_message_id_fkey to message_expansion_costs_message_id_fkey
  `.execute(db);
  await sql`
    alter table message_side_costs
      rename constraint message_side_costs_pkey to message_expansion_costs_pkey
  `.execute(db);
  await db.schema.alterTable('message_side_costs').renameTo('message_expansion_costs').execute();
}
