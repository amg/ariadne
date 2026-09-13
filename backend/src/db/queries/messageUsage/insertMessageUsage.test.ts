import { randomUUID } from 'node:crypto';
import { getMessageUsageByMessageId } from '@queries/messageUsage/getMessageUsageByMessageId';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createAssistantMessage(): Promise<string> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ user_id: userId, title: 'Test thread' });
  const message = await insertMessage({ thread_id: thread.id, role: 'assistant', content: 'hi' });
  return message.id;
}

describe('insertMessageUsage', () => {
  useTestDb();

  it('inserts a usage row linked 1:1 to its message', async () => {
    const messageId = await createAssistantMessage();

    const inserted = await insertMessageUsage({
      message_id: messageId,
      model: 'Qwen/Qwen3.5-9B',
      provider_id: 'chatcmpl-123',
      prompt_tokens: 42,
      completion_tokens: 7,
      cached_input_tokens: 3,
      cache_write_tokens: 2,
      cost_usd: '0.0000052500',
      finish_reason: 'stop',
      latency_ms: 123,
    });

    expect(inserted.message_id).toBe(messageId);
    expect(inserted.cost_usd).toBe('0.0000052500');
    expect(inserted.latency_ms).toBe(123);

    const fetched = await getMessageUsageByMessageId({ messageId });
    expect(fetched?.prompt_tokens).toBe(42);
    expect(fetched?.finish_reason).toBe('stop');
  });

  it('rejects a second row for the same message (1:1 via PK)', async () => {
    const messageId = await createAssistantMessage();
    const first = await insertMessageUsage({
      message_id: messageId,
      model: 'm',
      provider_id: 'p',
      prompt_tokens: 1,
      completion_tokens: 1,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: '0.0000000000',
      finish_reason: 'stop',
    });
    expect(first.latency_ms).toBeNull();

    await expect(
      insertMessageUsage({
        message_id: messageId,
        model: 'm2',
        provider_id: 'p2',
        prompt_tokens: 2,
        completion_tokens: 2,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: '0.0000000001',
        finish_reason: 'stop',
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
