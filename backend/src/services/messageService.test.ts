import { randomUUID } from 'node:crypto';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { getMessages } from '@services/messageService';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createRandomThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ user_id: userId, title: 'Test thread' });
  return { userId, threadId: thread.id };
}

describe('messageService', () => {
  useTestDb();

  describe('getMessages', () => {
    it('returns null when the thread is unknown or foreign', async () => {
      const { userId } = await createRandomThread();

      expect(await getMessages({ userId, threadId: randomUUID() })).toBeNull();

      const other = await createRandomThread();
      expect(await getMessages({ userId, threadId: other.threadId })).toBeNull();
    });

    it('returns messages with usage nested when a usage row exists', async () => {
      const { userId, threadId } = await createRandomThread();
      const userMessage = await insertMessage({
        thread_id: threadId,
        role: 'user',
        content: 'hello',
      });
      const assistantMessage = await insertMessage({
        thread_id: threadId,
        role: 'assistant',
        content: 'world',
      });
      await insertMessageUsage({
        message_id: assistantMessage.id,
        model: 'Qwen/Qwen3.5-9B',
        provider_id: 'chatcmpl-1',
        prompt_tokens: 5,
        completion_tokens: 1,
        cached_input_tokens: 3,
        cache_write_tokens: 2,
        reasoning_tokens: 1,
        cost_usd: '0.0000006500',
        finish_reason: 'stop',
        latency_ms: 42,
      });

      const messages = await getMessages({ userId, threadId });

      expect(messages?.map((m) => m.content)).toEqual(['hello', 'world']);
      expect(messages?.[0]?.usage).toBeNull();
      expect(messages?.[1]?.usage).toEqual({
        model: 'Qwen/Qwen3.5-9B',
        provider_id: 'chatcmpl-1',
        prompt_tokens: 5,
        completion_tokens: 1,
        cached_input_tokens: 3,
        cache_write_tokens: 2,
        reasoning_tokens: 1,
        cost_usd: '0.0000006500',
        finish_reason: 'stop',
        latency_ms: 42,
      });
    });
  });
});
