import { findUserById } from '@queries/users/findUserById';
import { DEFAULT_USER_ID, seedDefaultUser } from '@services/userService';
import { useTestDb } from '@test/test-db';
import { describe, expect, it, vi } from 'vitest';

describe('userService', () => {
  const db = useTestDb();

  describe('seedDefaultUser', () => {
    it('creates the default user when missing and reports true', async () => {
      const seeded = await seedDefaultUser(db);

      expect(seeded).toBe(true);
      const user = await findUserById(db, DEFAULT_USER_ID);
      expect(user?.id).toBe(DEFAULT_USER_ID);
    });

    it('is idempotent: second run is a no-op and reports false', async () => {
      await seedDefaultUser(db);

      const seededAgain = await seedDefaultUser(db);

      expect(seededAgain).toBe(false);
      const user = await findUserById(db, DEFAULT_USER_ID);
      expect(user?.id).toBe(DEFAULT_USER_ID);
    });

    it('seeds exactly once under concurrent calls (no race)', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => seedDefaultUser(db)));

      expect(results.filter((seeded) => seeded)).toHaveLength(1);
      const user = await findUserById(db, DEFAULT_USER_ID);
      expect(user?.id).toBe(DEFAULT_USER_ID);
    });

    it('logs only when the user is freshly seeded', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await seedDefaultUser(db);
        await seedDefaultUser(db);
        expect(log.mock.calls.filter((args) => args[0] === 'Seeded default user')).toHaveLength(1);
      } finally {
        log.mockRestore();
      }
    });
  });
});
