import { randomUUID } from 'node:crypto';
import type { NewMessage } from '@db/types';
import { findPromptOfReplyOrNull } from '@queries/messages/findPromptOfReplyOrNull';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createRandomThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Test thread' });
  return thread.id;
}

/** Stores the rows one second apart, in the order given, and returns them. */
async function storeInOrder(threadId: string, rows: Omit<NewMessage, 'threadId'>[]) {
  const stored = [];
  for (const [index, row] of rows.entries()) {
    const createdAt = new Date(Date.UTC(2026, 9, 29, 10, 0, index));
    stored.push(await insertMessage({ ...row, threadId, createdAt }));
  }
  return stored;
}

describe('findPromptOfReplyOrNull', () => {
  useTestDb();

  it('finds the newest user Message above the reply, not an older one or a later one', async () => {
    const threadId = await createRandomThread();
    const [, , prompt, reply] = await storeInOrder(threadId, [
      { role: 'user', content: 'older' },
      { role: 'assistant', content: 'older reply' },
      { role: 'user', content: 'the prompt' },
      { role: 'assistant', content: '', exchangeStatus: 'pending' },
      { role: 'user', content: 'later' },
    ]);

    const found = await findPromptOfReplyOrNull({ threadId, replyId: reply?.id ?? '' });

    expect(found?.id).toBe(prompt?.id);
  });

  it('finds an abandoned prompt too', async () => {
    const threadId = await createRandomThread();
    const [prompt, reply] = await storeInOrder(threadId, [
      { role: 'user', content: 'edited away', abandoned: true },
      { role: 'assistant', content: 'its reply', abandoned: true },
    ]);

    const found = await findPromptOfReplyOrNull({ threadId, replyId: reply?.id ?? '' });

    expect(found?.id).toBe(prompt?.id);
  });

  it('is null for a reply with no user Message above it', async () => {
    const threadId = await createRandomThread();
    const [reply] = await storeInOrder(threadId, [{ role: 'assistant', content: '' }]);

    expect(await findPromptOfReplyOrNull({ threadId, replyId: reply?.id ?? '' })).toBeNull();
  });
});
