import type { Database } from '@db/types';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import type { Kysely } from 'kysely';

export const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Ensures the default user exists. Idempotent and race-proof (single
 * ON CONFLICT statement). Returns `true` when the user was freshly seeded.
 */
export async function seedDefaultUser(db: Kysely<Database>): Promise<boolean> {
  const inserted = await insertUserIfNotExists(db, DEFAULT_USER_ID);
  if (inserted) {
    console.log('Seeded default user');
  }
  return inserted !== undefined;
}
