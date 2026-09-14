import { randomUUID } from 'node:crypto';
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
  const thread = await insertThread({ user_id: userId, title: 'Test thread' });
  return { userId, threadId: thread.id };
}

describe('deleteMessage', () => {
  useTestDb();

  it('deletes the message and returns its id', async () => {
    const { threadId } = await createRandomThread();
    const message = await insertMessage({ thread_id: threadId, role: 'user', content: 'bye' });

    const deletedId = await deleteMessage({ messageId: message.id });

    expect(deletedId).toBe(message.id);
    expect(await listMessagesByThread({ threadId })).toEqual([]);
  });

  it('cascades the 1:1 message_usage row', async () => {
    const { threadId } = await createRandomThread();
    const assistant = await insertMessage({
      thread_id: threadId,
      role: 'assistant',
      content: 'answer',
    });
    await insertMessageUsage({
      message_id: assistant.id,
      model: 'Qwen/Qwen3.5-9B',
      provider_id: 'chatcmpl-1',
      prompt_tokens: 5,
      completion_tokens: 1,
      cached_input_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
      cost_usd: '0.0000006500',
      finish_reason: 'stop',
      latency_ms: 42,
    });

    await deleteMessage({ messageId: assistant.id });

    expect(await getMessageUsageByMessageId({ messageId: assistant.id })).toBeUndefined();
  });

  it('returns undefined for an unknown id', async () => {
    await createRandomThread();
    expect(await deleteMessage({ messageId: randomUUID() })).toBeUndefined();
  });
});
