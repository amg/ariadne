import { randomUUID } from 'node:crypto';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { insertThread } from '@queries/threads/insertThread';
import { findUserById } from '@queries/users/findUserById';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  ThreadValidationError,
  createThread,
  getThreads,
  renameThread,
} from '@services/threadService';
import { DEFAULT_USER_ID, seedDefaultUser } from '@services/userService';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

describe('threadService', () => {
  const db = useTestDb();

  describe('createThread', () => {
    it('creates a thread with the given title for the given user', async () => {
      await seedDefaultUser(db);

      const thread = await createThread(db, DEFAULT_USER_ID, 'My Topic');

      expect(thread.title).toBe('My Topic');
      expect(thread.user_id).toBe(DEFAULT_USER_ID);
      expect(await findUserById(db, thread.user_id)).toBeDefined();
    });

    it('falls back to "New Chat" when no title is given', async () => {
      await seedDefaultUser(db);

      const thread = await createThread(db, DEFAULT_USER_ID);

      expect(thread.title).toBe('New Chat');
    });

    it('treats an empty title as missing', async () => {
      await seedDefaultUser(db);

      const thread = await createThread(db, DEFAULT_USER_ID, '');

      expect(thread.title).toBe('New Chat');
    });

    it('rejects when the user does not exist (FK violation)', async () => {
      await expect(createThread(db, randomUUID(), 'Orphan')).rejects.toMatchObject({
        code: '23503',
      });
    });
  });

  describe('renameThread', () => {
    it('renames a thread and returns the updated row', async () => {
      await seedDefaultUser(db);
      const thread = await createThread(db, DEFAULT_USER_ID, 'Old');

      const renamed = await renameThread(db, DEFAULT_USER_ID, thread.id, 'New');

      expect(renamed?.id).toBe(thread.id);
      expect(renamed?.title).toBe('New');
      const [listed] = await getThreads(db, DEFAULT_USER_ID);
      expect(listed?.title).toBe('New');
    });

    it('trims surrounding whitespace before persisting', async () => {
      await seedDefaultUser(db);
      const thread = await createThread(db, DEFAULT_USER_ID, 'Old');

      const renamed = await renameThread(db, DEFAULT_USER_ID, thread.id, '  Spaced  ');

      expect(renamed?.title).toBe('Spaced');
    });

    it('rejects a blank or whitespace-only title', async () => {
      await seedDefaultUser(db);
      const thread = await createThread(db, DEFAULT_USER_ID, 'Kept');

      for (const bad of ['', '   ']) {
        await expect(renameThread(db, DEFAULT_USER_ID, thread.id, bad)).rejects.toBeInstanceOf(
          ThreadValidationError,
        );
      }
      const [kept] = await getThreads(db, DEFAULT_USER_ID);
      expect(kept?.title).toBe('Kept');
    });

    it('rejects titles longer than 255 characters', async () => {
      await seedDefaultUser(db);
      const thread = await createThread(db, DEFAULT_USER_ID, 'Old');

      await expect(
        renameThread(db, DEFAULT_USER_ID, thread.id, 'x'.repeat(256)),
      ).rejects.toBeInstanceOf(ThreadValidationError);
    });

    it('returns null when the thread does not exist', async () => {
      await expect(renameThread(db, DEFAULT_USER_ID, randomUUID(), 'Anything')).resolves.toBeNull();
    });

    it('refuses to rename another user’s thread and leaves it untouched', async () => {
      await seedDefaultUser(db);
      const thread = await createThread(db, DEFAULT_USER_ID, 'Owned');
      const stranger = randomUUID();
      await insertUserIfNotExists(db, stranger);

      await expect(renameThread(db, stranger, thread.id, 'Stolen')).resolves.toBeNull();

      expect((await findThreadByIdAndUser(db, DEFAULT_USER_ID, thread.id))?.title).toBe('Owned');
    });
  });

  describe('getThreads', () => {
    it('returns an empty list when no threads exist', async () => {
      const threads = await getThreads(db, DEFAULT_USER_ID);

      expect(threads).toEqual([]);
    });

    it('returns only the given user’s threads, newest first', async () => {
      await seedDefaultUser(db);
      const first = await createThread(db, DEFAULT_USER_ID, 'First');
      const second = await createThread(db, DEFAULT_USER_ID, 'Second');

      // Another user's thread must not leak into the list
      const stranger = randomUUID();
      await insertUserIfNotExists(db, stranger);
      await insertThread(db, { user_id: stranger, title: 'Someone else' });

      const threads = await getThreads(db, DEFAULT_USER_ID);

      expect(threads.map((t) => t.title)).toEqual(['Second', 'First']);
      expect(threads.map((t) => t.id)).toEqual([second.id, first.id]);
    });
  });
});
