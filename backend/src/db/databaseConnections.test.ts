import { databaseConnections, db } from '@db/db';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

useTestDb();

describe('databaseConnections', () => {
  it('counts a connection as in use while a transaction holds it', async () => {
    const idle = databaseConnections();

    const during = await db.transaction().execute(async () => databaseConnections());

    expect(during.inUse).toBeGreaterThan(idle.inUse);
    expect(during.waiting).toBe(0);
  });
});
