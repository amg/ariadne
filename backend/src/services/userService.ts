import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';

export const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Ensures the default user exists. Idempotent and race-proof (single
 * ON CONFLICT statement). Returns `true` when the user was freshly seeded.
 */
export async function seedDefaultUser() {
  const inserted = await insertUserIfNotExists({ id: DEFAULT_USER_ID });
  if (inserted) {
    console.log('Seeded default user');
  }
  return inserted !== undefined;
}
