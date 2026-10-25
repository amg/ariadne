import { db } from '@db/db';

type InsertUserIfNotExistsProps = {
  id: string;
};

/**
 * Idempotent insert. Returns the inserted user, or `undefined` when a row
 * with the given id already existed (single statement, race-proof via
 * ON CONFLICT DO NOTHING instead of select-then-insert).
 */
export async function insertUserIfNotExists({ id }: InsertUserIfNotExistsProps) {
  return db
    .insertInto('chat.users')
    .values({ id })
    .onConflict((oc) => oc.column('id').doNothing())
    .returningAll()
    .executeTakeFirst();
}
