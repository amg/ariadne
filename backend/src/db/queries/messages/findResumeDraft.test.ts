import { randomUUID } from 'node:crypto';
import { findResumeDraft } from '@queries/messages/findResumeDraft';
import { insertMessage } from '@queries/messages/insertMessage';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId });
  return thread.id;
}

describe('findResumeDraft', () => {
  useTestDb();

  it('returns nothing for a thread without an abandoned arrival', async () => {
    const threadId = await createThread();
    expect(await findResumeDraft({ threadId })).toBeUndefined();

    await insertMessage({ threadId, role: 'user', content: 'hello' });
    await insertMessage({
      threadId,
      role: 'assistant',
      content: 'hi',
      exchangeStatus: 'completed',
    });
    // The newest user row was never abandoned.
    expect(await findResumeDraft({ threadId })).toBeUndefined();
  });

  it('offers the newest abandoned arrival back to the input', async () => {
    const threadId = await createThread();

    const user = await insertMessage({ threadId, role: 'user', content: 'an interrupted arrival' });
    await setMessagesAbandoned({ messageIds: [user.id], abandoned: true });
    // The aborted exchange left a non-completed assistant row behind.
    await insertMessage({
      threadId,
      role: 'assistant',
      content: '',
      exchangeStatus: 'interrupted',
    });

    expect(await findResumeDraft({ threadId })).toEqual({
      messageId: user.id,
      content: 'an interrupted arrival',
    });
  });

  it('stays owed while a later assistant row never completed', async () => {
    const threadId = await createThread();

    const user = await insertMessage({ threadId, role: 'user', content: 'still owed' });
    await setMessagesAbandoned({ messageIds: [user.id], abandoned: true });
    await insertMessage({ threadId, role: 'assistant', content: 'boom', exchangeStatus: 'error' });

    expect(await findResumeDraft({ threadId })).toEqual({
      messageId: user.id,
      content: 'still owed',
    });
  });

  it('is consumed by a completed exchange after the abandoned arrival', async () => {
    const threadId = await createThread();

    const user = await insertMessage({ threadId, role: 'user', content: 'recovered' });
    await setMessagesAbandoned({ messageIds: [user.id], abandoned: true });
    await insertMessage({
      threadId,
      role: 'assistant',
      content: 'answer',
      exchangeStatus: 'completed',
    });

    expect(await findResumeDraft({ threadId })).toBeUndefined();
  });

  it('ignores a non-newest abandoned arrival', async () => {
    const threadId = await createThread();

    const first = await insertMessage({ threadId, role: 'user', content: 'old interrupted' });
    await setMessagesAbandoned({ messageIds: [first.id], abandoned: true });
    // The conversation moved on with a fresh arrival.
    await insertMessage({
      threadId,
      role: 'assistant',
      content: '',
      exchangeStatus: 'interrupted',
    });
    await insertMessage({ threadId, role: 'user', content: 'fresh arrival' });

    expect(await findResumeDraft({ threadId })).toBeUndefined();
  });
});
