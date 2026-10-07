import { randomUUID } from 'node:crypto';
import { getSideCostByMessageId } from '@queries/messageSideCosts/getSideCostByMessageId';
import { upsertSideCost } from '@queries/messageSideCosts/upsertSideCost';
import { getMessageUsageByMessageId } from '@queries/messageUsage/getMessageUsageByMessageId';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { deleteMessage } from '@queries/messages/deleteMessage';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createRandomThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId: userId, title: 'Test thread' });
  return { userId, threadId: thread.id };
}

describe('deleteMessage', () => {
  useTestDb();

  it('deletes the message and returns its id', async () => {
    const { threadId } = await createRandomThread();
    const message = await insertMessage({ threadId: threadId, role: 'user', content: 'bye' });

    const deletedId = await deleteMessage({ messageId: message.id });

    expect(deletedId).toBe(message.id);
    expect(await listMessagesByThread({ threadId })).toEqual([]);
  });

  it('cascades the 1:1 message_usage row', async () => {
    const { threadId } = await createRandomThread();
    const assistant = await insertMessage({
      threadId: threadId,
      role: 'assistant',
      content: 'answer',
    });
    await insertMessageUsage({
      messageId: assistant.id,
      model: 'Qwen/Qwen3.5-9B',
      providerId: 'chatcmpl-1',
      promptTokens: 5,
      completionTokens: 1,
      cachedInputTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      costUsd: '0.0000006500',
      finishReason: 'stop',
      latencyMs: 42,
    });
    // Side-call spends cascade too.
    await upsertSideCost({
      messageId: assistant.id,
      kind: 'rewrite',
      model: 'Qwen/Qwen3.5-9B',
      costUsd: '0.0000000100',
    });

    await deleteMessage({ messageId: assistant.id });

    expect(await getMessageUsageByMessageId({ messageId: assistant.id })).toBeUndefined();
    expect(
      await getSideCostByMessageId({ messageId: assistant.id, kind: 'rewrite' }),
    ).toBeUndefined();
  });

  it('returns undefined for an unknown id', async () => {
    await createRandomThread();
    expect(await deleteMessage({ messageId: randomUUID() })).toBeUndefined();
  });
});
