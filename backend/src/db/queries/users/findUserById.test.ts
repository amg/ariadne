import { randomUUID } from 'node:crypto';
import { findUserById } from '@queries/users/findUserById';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

describe('findUserById', () => {
  const db = useTestDb();

  it('returns the user when it exists', async () => {
    const id = randomUUID();
    await insertUserIfNotExists(db, id);

    const user = await findUserById(db, id);

    expect(user).toBeDefined();
    expect(user?.id).toBe(id);
    expect(user?.created_at).toBeInstanceOf(Date);
  });

  it('returns undefined when the user does not exist', async () => {
    const user = await findUserById(db, randomUUID());

    expect(user).toBeUndefined();
  });
});
