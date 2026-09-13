import { db } from '@db/db';
import type { User } from '@db/types';

/**
 * Idempotent insert. Returns the inserted user, or `undefined` when a row
 * with the given id already existed (single statement, race-proof via
 * ON CONFLICT DO NOTHING instead of select-then-insert).
 */
export async function insertUserIfNotExists(id: string): Promise<User | undefined> {
  return db
    .insertInto('users')
    .values({ id })
    .onConflict((oc) => oc.column('id').doNothing())
    .returningAll()
    .executeTakeFirst();
}
