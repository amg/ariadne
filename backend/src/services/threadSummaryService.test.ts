import { randomUUID } from 'node:crypto';
import { env } from '@config/env';
import { upsertArrivalEmbedding } from '@queries/messageEmbeddings/upsertArrivalEmbedding';
import { upsertSideCost } from '@queries/messageSideCosts/upsertSideCost';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { deleteMessage } from '@queries/messages/deleteMessage';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService/config';
import { getThreadSummary } from '@services/threadSummaryService';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createUserAndThread(): Promise<{ userId: string; threadId: string }> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Summary thread' });
  return { userId, threadId: thread.id };
}

async function addChatExchange(
  threadId: string,
  costUsd: string,
  reasoning: { reported: number | null; estimated: number | null } = {
    reported: null,
    estimated: null,
  },
): Promise<void> {
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
    reasoningTokens: reasoning.reported,
    estimatedReasoningTokens: reasoning.estimated,
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
      memory: '0.0000000000',
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
    // The embedding spend rides the arrival row; the rewrite/judge spends
    // land as expansion-cost rows.
    await upsertArrivalEmbedding({
      messageId: userMessage.id,
      embedding: new Array<number>(1024).fill(0),
      modelId: EMBEDDING_MODEL_ID,
      embeddingCostUsd: 0.00000001,
    });
    await upsertSideCost({
      messageId: userMessage.id,
      kind: 'rewrite',
      model: env.REWRITE_MODEL,
      costUsd: '0.0000002000',
    });
    await upsertSideCost({
      messageId: userMessage.id,
      kind: 'judge',
      model: env.REWRITE_MODEL,
      costUsd: '0.0000003000',
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
      memory: '0.0000000000',
    });
    // One entry per distinct model, roles grouped; rewrite and judge share
    // a model id, so they collapse into a single entry.
    expect(summary?.models).toEqual([
      { modelId: 'provider/model-a', roles: ['chat'], pricing: null },
      { modelId: EMBEDDING_MODEL_ID, roles: ['embedding'], pricing: null },
      { modelId: env.REWRITE_MODEL, roles: ['rewrite', 'judge'], pricing: null },
    ]);
  });

  it('adds Fact capture spend to the total as its own memory line', async () => {
    const { userId, threadId } = await createUserAndThread();
    await addChatExchange(threadId, '0.0000052500');
    const boundary = await insertMessage({ threadId, role: 'user', content: 'new topic' });
    await upsertSideCost({
      messageId: boundary.id,
      kind: 'fact_extraction',
      model: env.MEMORY_MODEL,
      costUsd: '0.0000004000',
    });
    await upsertSideCost({
      messageId: boundary.id,
      kind: 'fact_duplicate_check',
      model: env.MEMORY_MODEL,
      costUsd: '0.0000001000',
    });

    const summary = await getThreadSummary({ userId, threadId });
    expect(summary?.totalCostUsd).toBe('0.0000057500');
    expect(summary?.costBreakdown.memory).toBe('0.0000005000');
    expect(summary?.models.some((model) => model.roles.includes('memory'))).toBe(true);
  });

  it('counts estimated reasoning when the provider reports none', async () => {
    const { userId, threadId } = await createUserAndThread();
    await addChatExchange(threadId, '0.0000052500', { reported: 0, estimated: 916 });
    await addChatExchange(threadId, '0.0000052500', { reported: 7, estimated: null });
    await addChatExchange(threadId, '0.0000052500');

    const summary = await getThreadSummary({ userId, threadId });
    expect(summary?.totalTokens.reasoning).toBe(923);
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

  it('counts only visible rows: deleting a message deletes its spend with it', async () => {
    const { userId, threadId } = await createUserAndThread();
    await addChatExchange(threadId, '0.0000052500');

    const assistant = (await listMessagesByThread({ threadId })).find(
      (row) => row.role === 'assistant',
    );
    expect(assistant).toBeDefined();

    const before = await getThreadSummary({ userId, threadId });
    expect(before?.totalCostUsd).toBe('0.0000052500');

    // Spend rides its message row: the hard delete cascades the ledger row,
    // so the thread total only ever reflects what the user can still see.
    await deleteMessage({ messageId: assistant?.id as string });
    const after = await getThreadSummary({ userId, threadId });
    expect(after?.totalCostUsd).toBe('0.0000000000');
  });
});
