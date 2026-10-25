import { randomUUID } from 'node:crypto';
import { getMessageUsageByMessageId } from '@queries/messageUsage/getMessageUsageByMessageId';
import { insertMessageUsageIfAbsent } from '@queries/messageUsage/insertMessageUsageIfAbsent';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createAssistantMessage() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Test thread' });
  const message = await insertMessage({ threadId: thread.id, role: 'assistant', content: 'hi' });
  return message.id;
}

function usageFor({ messageId, promptTokens }: { messageId: string; promptTokens: number }) {
  return {
    messageId,
    model: 'm',
    providerId: 'p',
    promptTokens,
    completionTokens: 1,
    costUsd: '0.0000000000',
    finishReason: 'interrupted' as const,
    estimated: true,
  };
}

describe('insertMessageUsageIfAbsent', () => {
  useTestDb();

  it('records the row when the message has none', async () => {
    const messageId = await createAssistantMessage();

    expect(await insertMessageUsageIfAbsent(usageFor({ messageId, promptTokens: 5 }))).toBe(true);

    expect((await getMessageUsageByMessageId({ messageId }))?.promptTokens).toBe(5);
  });

  it('leaves the existing row alone and reports that it did not insert', async () => {
    const messageId = await createAssistantMessage();
    await insertMessageUsageIfAbsent(usageFor({ messageId, promptTokens: 5 }));

    expect(await insertMessageUsageIfAbsent(usageFor({ messageId, promptTokens: 99 }))).toBe(false);

    expect((await getMessageUsageByMessageId({ messageId }))?.promptTokens).toBe(5);
  });

  it('still fails for a message that does not exist', async () => {
    await expect(
      insertMessageUsageIfAbsent(usageFor({ messageId: randomUUID(), promptTokens: 1 })),
    ).rejects.toThrow();
  });
});
