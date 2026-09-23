import { randomUUID } from 'node:crypto';
import { upsertArrivalEmbedding } from '@queries/messageEmbeddings/upsertArrivalEmbedding';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID, REWRITE_MODEL_ID } from '@services/aiService/config';
import { getThreadSummary } from '@services/threadSummaryService';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

const ZERO_VECTOR = new Array<number>(1024).fill(0);

async function createUserAndThread(): Promise<{ userId: string; threadId: string }> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Summary thread' });
  return { userId, threadId: thread.id };
}

async function addChatExchange(threadId: string, costUsd: string): Promise<void> {
  await insertMessage({ threadId, role: 'user', content: 'hello' });
  const assistantMessage = await insertMessage({
    threadId,
    role: 'assistant',
    content: 'hi there',
  });
  await insertMessageUsage({
    messageId: assistantMessage.id,
    model: 'provider/model-a',
    providerId: randomUUID(),
    promptTokens: 100,
    completionTokens: 20,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    finishReason: 'stop',
  });
}

describe('getThreadSummary', () => {
  useTestDb();

  it('returns zero totals with a flat breakdown for an empty thread', async () => {
    const { userId, threadId } = await createUserAndThread();

    const summary = await getThreadSummary({ userId, threadId });
    expect(summary).not.toBeNull();
    expect(summary?.totalCostUsd).toBe('0.0000000000');
    expect(summary?.costBreakdown).toEqual({
      chat: '0.0000000000',
      embedding: '0.0000000000',
      rewrite: '0.0000000000',
      judge: '0.0000000000',
    });
    expect(summary?.models).toEqual([]);
  });

  it('adds analyzer pipeline spend to the total and breaks it down', async () => {
    const { userId, threadId } = await createUserAndThread();
    await addChatExchange(threadId, '0.0000052500');

    const userMessage = await insertMessage({
      threadId,
      role: 'user',
      content: 'what about that?',
    });
    await upsertArrivalEmbedding({
      messageId: userMessage.id,
      embedding: ZERO_VECTOR,
      modelId: 'embed/model',
      embeddingCostUsd: 0.00000001,
      rewriteCostUsd: 0.0000002,
      judgeCostUsd: 0.0000003,
    });

    const summary = await getThreadSummary({ userId, threadId });
    expect(summary).not.toBeNull();
    // Chat 0.00000525 + embedding 0.00000001 + rewrite 0.0000002 + judge 0.0000003
    expect(summary?.totalCostUsd).toBe('0.0000057600');
    expect(summary?.costBreakdown).toEqual({
      chat: '0.0000052500',
      embedding: '0.0000000100',
      rewrite: '0.0000002000',
      judge: '0.0000003000',
    });
    // One entry per distinct model, roles grouped; rewrite and judge share
    // a model id, so they collapse into a single entry.
    expect(summary?.models).toEqual([
      { modelId: 'provider/model-a', roles: ['chat'], pricing: null },
      { modelId: EMBEDDING_MODEL_ID, roles: ['embedding'], pricing: null },
      { modelId: REWRITE_MODEL_ID, roles: ['rewrite', 'judge'], pricing: null },
    ]);
  });

  it('total equals chat cost alone when the analyzer recorded nothing', async () => {
    const { userId, threadId } = await createUserAndThread();
    await addChatExchange(threadId, '0.0000052500');

    const summary = await getThreadSummary({ userId, threadId });
    expect(summary).not.toBeNull();
    expect(summary?.totalCostUsd).toBe('0.0000052500');
    expect(summary?.costBreakdown.chat).toBe('0.0000052500');
    expect(summary?.costBreakdown.embedding).toBe('0.0000000000');
    expect(summary?.costBreakdown.rewrite).toBe('0.0000000000');
    expect(summary?.costBreakdown.judge).toBe('0.0000000000');
    // Only the chat model spent: no analyzer slots appear.
    expect(summary?.models).toEqual([
      { modelId: 'provider/model-a', roles: ['chat'], pricing: null },
    ]);
  });
});
