import { randomUUID } from 'node:crypto';
import { insertThread } from '@queries/threads/insertThread';
import { findUserById } from '@queries/users/findUserById';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { createThread, getThreads } from '@services/threadService';
import { DEFAULT_USER_ID, seedDefaultUser } from '@services/userService';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

describe('threadService', () => {
  const db = useTestDb();

  describe('createThread', () => {
    it('creates a thread with the given title for the default user', async () => {
      await seedDefaultUser(db);

      const thread = await createThread(db, 'My Topic');

      expect(thread.title).toBe('My Topic');
      expect(thread.user_id).toBe(DEFAULT_USER_ID);
      expect(await findUserById(db, thread.user_id)).toBeDefined();
    });

    it('falls back to "New Chat" when no title is given', async () => {
      await seedDefaultUser(db);

      const thread = await createThread(db);

      expect(thread.title).toBe('New Chat');
    });

    it('treats an empty title as missing', async () => {
      await seedDefaultUser(db);

      const thread = await createThread(db, '');

      expect(thread.title).toBe('New Chat');
    });
  });

  describe('getThreads', () => {
    it('returns an empty list when no threads exist', async () => {
      const threads = await getThreads(db);

      expect(threads).toEqual([]);
    });

    it('returns only the default user’s threads, newest first', async () => {
      await seedDefaultUser(db);
      const first = await createThread(db, 'First');
      const second = await createThread(db, 'Second');

      // Another user's thread must not leak into the list
      const stranger = randomUUID();
      await insertUserIfNotExists(db, stranger);
      await insertThread(db, { user_id: stranger, title: 'Someone else' });

      const threads = await getThreads(db);

      expect(threads.map((t) => t.title)).toEqual(['Second', 'First']);
      expect(threads.map((t) => t.id)).toEqual([second.id, first.id]);
    });
  });
});
