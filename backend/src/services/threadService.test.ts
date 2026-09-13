import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { insertThread } from '@queries/threads/insertThread';
import { findUserById } from '@queries/users/findUserById';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  ThreadValidationError,
  createThread,
  deleteThread,
  getThreads,
  renameThread,
} from '@services/threadService';
import { DEFAULT_USER_ID, seedDefaultUser } from '@services/userService';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

describe('threadService', () => {
  useTestDb();

  describe('createThread', () => {
    it('creates a thread with the given title for the given user', async () => {
      await seedDefaultUser();

      const thread = await createThread({ userId: DEFAULT_USER_ID, title: 'My Topic' });

      expect(thread.title).toBe('My Topic');
      expect(thread.user_id).toBe(DEFAULT_USER_ID);
      expect(await findUserById({ id: thread.user_id })).toBeDefined();
    });

    it('falls back to "New Chat" when no title is given', async () => {
      await seedDefaultUser();

      const thread = await createThread({ userId: DEFAULT_USER_ID });

      expect(thread.title).toBe('New Chat');
    });

    it('treats an empty title as missing', async () => {
      await seedDefaultUser();

      const thread = await createThread({ userId: DEFAULT_USER_ID, title: '' });

      expect(thread.title).toBe('New Chat');
    });

    it('rejects when user does not exist (FK violation)', async () => {
      await expect(createThread({ userId: randomUUID(), title: 'Orphan' })).rejects.toMatchObject({
        code: '23503',
      });
    });
  });

  describe('renameThread', () => {
    it('renames a thread and returns the updated row', async () => {
      await seedDefaultUser();
      const thread = await createThread({ userId: DEFAULT_USER_ID, title: 'Old' });

      const renamed = await renameThread({
        userId: DEFAULT_USER_ID,
        threadId: thread.id,
        title: 'New',
      });

      expect(renamed?.id).toBe(thread.id);
      expect(renamed?.title).toBe('New');
      const [listed] = await getThreads({ userId: DEFAULT_USER_ID });
      expect(listed?.title).toBe('New');
    });

    it('trims surrounding whitespace before persisting', async () => {
      await seedDefaultUser();
      const thread = await createThread({ userId: DEFAULT_USER_ID, title: 'Old' });

      const renamed = await renameThread({
        userId: DEFAULT_USER_ID,
        threadId: thread.id,
        title: '  Spaced  ',
      });

      expect(renamed?.title).toBe('Spaced');
    });

    it('rejects a blank or whitespace-only title', async () => {
      await seedDefaultUser();
      const thread = await createThread({ userId: DEFAULT_USER_ID, title: 'Kept' });

      for (const bad of ['', '   ']) {
        await expect(
          renameThread({ userId: DEFAULT_USER_ID, threadId: thread.id, title: bad }),
        ).rejects.toBeInstanceOf(ThreadValidationError);
      }
      const [kept] = await getThreads({ userId: DEFAULT_USER_ID });
      expect(kept?.title).toBe('Kept');
    });

    it('rejects titles longer than 255 characters', async () => {
      await seedDefaultUser();
      const thread = await createThread({ userId: DEFAULT_USER_ID, title: 'Old' });

      await expect(
        renameThread({ userId: DEFAULT_USER_ID, threadId: thread.id, title: 'x'.repeat(256) }),
      ).rejects.toBeInstanceOf(ThreadValidationError);
    });

    it('returns null when the thread does not exist', async () => {
      await expect(
        renameThread({ userId: DEFAULT_USER_ID, threadId: randomUUID(), title: 'Anything' }),
      ).resolves.toBeNull();
    });

    it('refuses to rename another user thread and leaves it untouched', async () => {
      await seedDefaultUser();
      const thread = await createThread({ userId: DEFAULT_USER_ID, title: 'Owned' });
      const stranger = randomUUID();
      await insertUserIfNotExists({ id: stranger });

      await expect(
        renameThread({ userId: stranger, threadId: thread.id, title: 'Stolen' }),
      ).resolves.toBeNull();

      expect(
        (await findThreadByIdAndUser({ userId: DEFAULT_USER_ID, threadId: thread.id }))?.title,
      ).toBe('Owned');
    });
  });

  describe('getThreads', () => {
    it('returns an empty list when no threads exist', async () => {
      const threads = await getThreads({ userId: DEFAULT_USER_ID });

      expect(threads).toEqual([]);
    });

    it('returns only given user threads, newest first', async () => {
      await seedDefaultUser();
      const first = await createThread({ userId: DEFAULT_USER_ID, title: 'First' });
      const second = await createThread({ userId: DEFAULT_USER_ID, title: 'Second' });

      // Another user thread must not leak into the list
      const stranger = randomUUID();
      await insertUserIfNotExists({ id: stranger });
      await insertThread({ user_id: stranger, title: 'Someone else' });

      const threads = await getThreads({ userId: DEFAULT_USER_ID });

      expect(threads.map((t) => t.title)).toEqual(['Second', 'First']);
      expect(threads.map((t) => t.id)).toEqual([second.id, first.id]);
    });
  });

  describe('deleteThread', () => {
    it('deletes the thread and its messages', async () => {
      await seedDefaultUser();
      const thread = await createThread({ userId: DEFAULT_USER_ID, title: 'Doomed' });
      await insertMessage({ thread_id: thread.id, role: 'user', content: 'hello' });

      const deleted = await deleteThread({ userId: DEFAULT_USER_ID, threadId: thread.id });

      expect(deleted).toBe(true);
      expect(
        await findThreadByIdAndUser({ userId: DEFAULT_USER_ID, threadId: thread.id }),
      ).toBeUndefined();
      expect(await listMessagesByThread({ threadId: thread.id })).toHaveLength(0);
    });

    it('returns false when the thread does not exist', async () => {
      await seedDefaultUser();

      const deleted = await deleteThread({ userId: DEFAULT_USER_ID, threadId: randomUUID() });

      expect(deleted).toBe(false);
    });

    it('refuses to delete another user thread', async () => {
      await seedDefaultUser();
      const thread = await createThread({ userId: DEFAULT_USER_ID, title: 'Kept' });
      const stranger = randomUUID();
      await insertUserIfNotExists({ id: stranger });

      const deleted = await deleteThread({ userId: stranger, threadId: thread.id });

      expect(deleted).toBe(false);
      expect(
        await findThreadByIdAndUser({ userId: DEFAULT_USER_ID, threadId: thread.id }),
      ).toBeDefined();
    });
  });
});
