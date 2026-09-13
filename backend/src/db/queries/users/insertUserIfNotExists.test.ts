import { randomUUID } from 'node:crypto';
import { findUserById } from '@queries/users/findUserById';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

describe('insertUserIfNotExists', () => {
  const db = useTestDb();

  it('inserts and returns a new user', async () => {
    const id = randomUUID();

    const inserted = await insertUserIfNotExists(db, id);

    expect(inserted?.id).toBe(id);
    expect(inserted?.created_at).toBeInstanceOf(Date);

    const persisted = await findUserById(db, id);
    expect(persisted?.id).toBe(id);
  });

  it('is a no-op when the user already exists', async () => {
    const id = randomUUID();
    await insertUserIfNotExists(db, id);

    const second = await insertUserIfNotExists(db, id);

    expect(second).toBeUndefined();
    // Still exactly one row, no duplicate-key error raised
    const persisted = await findUserById(db, id);
    expect(persisted?.id).toBe(id);
  });

  it('inserts exactly one row under concurrent calls for the same id', async () => {
    const id = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => insertUserIfNotExists(db, id)),
    );

    const inserted = results.filter((user) => user !== undefined);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.id).toBe(id);
  });
});
