import { randomUUID } from 'node:crypto';
import { getMessageUsageByMessageId } from '@queries/messageUsage/getMessageUsageByMessageId';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createAssistantMessage() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId: userId, title: 'Test thread' });
  const message = await insertMessage({ threadId: thread.id, role: 'assistant', content: 'hi' });
  return message.id;
}

describe('insertMessageUsage', () => {
  useTestDb();

  it('inserts a spend row linked 1:1 to its message', async () => {
    const messageId = await createAssistantMessage();

    const inserted = await insertMessageUsage({
      messageId: messageId,
      model: 'Qwen/Qwen3.5-9B',
      providerId: 'chatcmpl-123',
      promptTokens: 42,
      completionTokens: 7,
      cachedInputTokens: 3,
      cacheWriteTokens: 2,
      costUsd: '0.0000052500',
      finishReason: 'stop',
      latencyMs: 123,
    });

    expect(inserted.messageId).toBe(messageId);
    // The insert-side default: provider-reported spend.
    expect(inserted.estimated).toBe(false);
    expect(inserted.costUsd).toBe('0.0000052500');
    expect(inserted.latencyMs).toBe(123);

    const fetched = await getMessageUsageByMessageId({ messageId });
    expect(fetched?.promptTokens).toBe(42);
    expect(fetched?.finishReason).toBe('stop');
  });

  it('rejects a second row for the same message (PK)', async () => {
    const messageId = await createAssistantMessage();
    const first = await insertMessageUsage({
      messageId: messageId,
      model: 'm',
      providerId: 'p',
      promptTokens: 1,
      completionTokens: 1,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costUsd: '0.0000000000',
      finishReason: 'stop',
    });
    expect(first.latencyMs).toBeNull();

    await expect(
      insertMessageUsage({
        messageId: messageId,
        model: 'm2',
        providerId: 'p2',
        promptTokens: 2,
        completionTokens: 2,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        costUsd: '0.0000000001',
        finishReason: 'stop',
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
