import { randomUUID } from 'node:crypto';
import { recordArrivalEmbedding } from '@queries/messageEmbeddings/recordArrivalEmbedding';
import { addSideCost } from '@queries/messageSideCosts/addSideCost';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { sumDailySpend } from '@queries/messageUsage/sumDailySpend';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService/config';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createThread(): Promise<{ threadId: string }> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Spend thread' });
  return { threadId: thread.id };
}

async function seedChatSpend(threadId: string, costUsd: string): Promise<void> {
  const user = await insertMessage({ threadId, role: 'user', content: 'hello' });
  const assistant = await insertMessage({ threadId, role: 'assistant', content: 'hi' });

  await insertMessageUsage({
    messageId: assistant.id,
    model: 'provider/chat',
    providerId: randomUUID(),
    promptTokens: 10,
    completionTokens: 5,
    costUsd,
    finishReason: 'stop',
  });
}

describe('sumDailySpend', () => {
  useTestDb();

  it('returns zero when there is no spend today', async () => {
    expect(await sumDailySpend()).toBe('0.0000000000');
  });

  it('sums all chat spend for the current UTC day', async () => {
    const { threadId } = await createThread();
    await seedChatSpend(threadId, '0.0000010000');
    await seedChatSpend(threadId, '0.0000020000');

    const total = await sumDailySpend();
    expect(total).toBe('0.0000030000');
  });

  it('includes spend from all sources (chat, embedding, expansion)', async () => {
    const { threadId } = await createThread();
    const user = await insertMessage({ threadId, role: 'user', content: 'test' });
    const assistant = await insertMessage({ threadId, role: 'assistant', content: 'response' });

    // Chat spend
    await insertMessageUsage({
      messageId: assistant.id,
      model: 'provider/chat',
      providerId: randomUUID(),
      promptTokens: 10,
      completionTokens: 5,
      costUsd: '0.0000010000',
      finishReason: 'stop',
    });

    // Embedding spend
    await recordArrivalEmbedding({
      messageId: user.id,
      embedding: new Array<number>(1024).fill(0),
      modelId: EMBEDDING_MODEL_ID,
      embeddingCostUsd: 0.0000005,
    });

    // Side-call spend (rewrite + judge)
    await addSideCost({
      messageId: user.id,
      kind: 'rewrite',
      model: 'test-model',
      costUsd: '0.0000003000',
      promptTokens: null,
      completionTokens: null,
    });
    await addSideCost({
      messageId: user.id,
      kind: 'judge',
      model: 'test-model',
      costUsd: '0.0000002000',
      promptTokens: null,
      completionTokens: null,
    });

    const total = await sumDailySpend();
    // 0.000001 + 0.0000005 + 0.0000003 + 0.0000002 = 0.0000020000
    expect(total).toBe('0.0000020000');
  });

  it('includes estimated rows', async () => {
    const { threadId } = await createThread();
    const assistant = await insertMessage({ threadId, role: 'assistant', content: 'estimated' });

    await insertMessageUsage({
      messageId: assistant.id,
      model: 'provider/chat',
      providerId: null, // No provider ID for estimated
      promptTokens: 10,
      completionTokens: 5,
      costUsd: '0.0000015000',
      finishReason: 'interrupted',
    });

    const total = await sumDailySpend();
    expect(total).toBe('0.0000015000');
  });
});
