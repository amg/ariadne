import { randomUUID } from 'node:crypto';
import { sumAnalyzerCostsByThread } from '@queries/messageEmbeddings/sumAnalyzerCostsByThread';
import { upsertArrivalEmbedding } from '@queries/messageEmbeddings/upsertArrivalEmbedding';
import { upsertMessageEmbedding } from '@queries/messageEmbeddings/upsertMessageEmbedding';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

const ZERO_VECTOR = new Array<number>(1024).fill(0);

async function createUserAndThread(): Promise<{ userId: string; threadId: string }> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Cost thread' });
  return { userId, threadId: thread.id };
}

async function addUserMessage(threadId: string): Promise<string> {
  const message = await insertMessage({ threadId, role: 'user', content: 'arrival' });
  return message.id;
}

describe('sumAnalyzerCostsByThread', () => {
  useTestDb();

  it('sums arrival-row costs per step and ignores other threads', async () => {
    const { threadId } = await createUserAndThread();
    const { threadId: otherThreadId } = await createUserAndThread();

    const first = await addUserMessage(threadId);
    await upsertArrivalEmbedding({
      messageId: first,
      embedding: ZERO_VECTOR,
      modelId: 'embed/model',
      embeddingCostUsd: 0.00000001,
      rewriteCostUsd: 0.00000002,
      judgeCostUsd: 0.00000004,
    });
    const second = await addUserMessage(threadId);
    await upsertArrivalEmbedding({
      messageId: second,
      embedding: ZERO_VECTOR,
      modelId: 'embed/model',
      embeddingCostUsd: 0.00000001,
      rewriteCostUsd: 0.00000003,
      judgeCostUsd: 0.00000004,
    });

    // Another thread's spend must not leak into the sum.
    const outsider = await addUserMessage(otherThreadId);
    await upsertArrivalEmbedding({
      messageId: outsider,
      embedding: ZERO_VECTOR,
      modelId: 'embed/model',
      embeddingCostUsd: 0.00000099,
      rewriteCostUsd: 0.00000099,
      judgeCostUsd: 0.00000099,
    });

    const totals = await sumAnalyzerCostsByThread({ threadId });
    expect(totals.embeddingCostUsd).toBe('0.0000000200');
    expect(totals.rewriteCostUsd).toBe('0.0000000500');
    expect(totals.judgeCostUsd).toBe('0.0000000800');
  });

  it('treats thread rows and null cost columns as zero', async () => {
    const { threadId } = await createUserAndThread();

    // Turn embedding keyed to an assistant message: no cost columns.
    const assistant = await insertMessage({ threadId, role: 'assistant', content: 'reply' });
    await upsertMessageEmbedding({
      messageId: assistant.id,
      embedding: ZERO_VECTOR,
      modelId: 'embed/model',
    });

    // Arrival row that only carries the embedding cost.
    const user = await addUserMessage(threadId);
    await upsertArrivalEmbedding({
      messageId: user,
      embedding: ZERO_VECTOR,
      modelId: 'embed/model',
      embeddingCostUsd: 0.00000001,
      rewriteCostUsd: null,
      judgeCostUsd: null,
    });

    const totals = await sumAnalyzerCostsByThread({ threadId });
    expect(totals.embeddingCostUsd).toBe('0.0000000100');
    expect(totals.rewriteCostUsd).toBe('0.0000000000');
    expect(totals.judgeCostUsd).toBe('0.0000000000');
  });

  it('returns zero sums for a thread the analyzer never touched', async () => {
    const { threadId } = await createUserAndThread();

    const totals = await sumAnalyzerCostsByThread({ threadId });
    expect(totals.embeddingCostUsd).toBe('0.0000000000');
    expect(totals.rewriteCostUsd).toBe('0.0000000000');
    expect(totals.judgeCostUsd).toBe('0.0000000000');
  });
});
