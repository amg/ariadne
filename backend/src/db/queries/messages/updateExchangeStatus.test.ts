import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { updateExchangeStatus } from '@queries/messages/updateExchangeStatus';
import { updateMessageContent } from '@queries/messages/updateMessageContent';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createRandomThread(): Promise<string> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId: userId, title: 'Test thread' });
  return thread.id;
}

// Single lifecycle hook for the whole file: useTestDb() destroys the pool in
// its afterAll, so a per-describe call would kill the DB before later suites.
useTestDb();

describe('updateExchangeStatus', () => {
  it('flips the exchange state without touching the content', async () => {
    const threadId = await createRandomThread();
    const message = await insertMessage({
      threadId,
      role: 'assistant',
      content: '',
      exchangeStatus: 'pending',
    });

    const updated = await updateExchangeStatus({
      messageId: message.id,
      exchangeStatus: 'interrupted',
    });

    expect(updated.exchangeStatus).toBe('interrupted');
    expect(updated.content).toBe('');
  });

  it('rejects an unknown message id', async () => {
    await expect(
      updateExchangeStatus({ messageId: randomUUID(), exchangeStatus: 'completed' }),
    ).rejects.toThrow();
  });
});

describe('updateMessageContent', () => {
  it('settles content and exchange state in one write', async () => {
    const threadId = await createRandomThread();
    const message = await insertMessage({
      threadId,
      role: 'assistant',
      content: '',
      exchangeStatus: 'pending',
    });

    const updated = await updateMessageContent({
      messageId: message.id,
      content: 'final text',
      exchangeStatus: 'completed',
    });

    expect(updated.content).toBe('final text');
    expect(updated.exchangeStatus).toBe('completed');
  });

  it('leaves the exchange state untouched when omitted', async () => {
    const threadId = await createRandomThread();
    const message = await insertMessage({
      threadId,
      role: 'assistant',
      content: '',
      exchangeStatus: 'pending',
    });

    const updated = await updateMessageContent({
      messageId: message.id,
      content: 'just the text',
    });

    expect(updated.content).toBe('just the text');
    expect(updated.exchangeStatus).toBe('pending');
  });
});
