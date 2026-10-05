import { randomUUID } from 'node:crypto';
import { env } from '@config/env';
import { upsertArrivalEmbedding } from '@queries/messageEmbeddings/upsertArrivalEmbedding';
import { upsertSideCost } from '@queries/messageSideCosts/upsertSideCost';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { sumThreadSpend } from '@queries/messageUsage/sumThreadSpend';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService/config';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

const ZERO = {
  chat: '0.0000000000',
  embedding: '0.0000000000',
  rewrite: '0.0000000000',
  judge: '0.0000000000',
  memory: '0.0000000000',
};

async function createThread(): Promise<{ threadId: string }> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Spend thread' });
  return { threadId: thread.id };
}

async function seedFullSpend(threadId: string): Promise<void> {
  const user = await insertMessage({ threadId, role: 'user', content: 'hello' });
  const assistant = await insertMessage({ threadId, role: 'assistant', content: 'hi' });

  await insertMessageUsage({
    messageId: assistant.id,
    model: 'provider/chat',
    providerId: randomUUID(),
    promptTokens: 10,
    completionTokens: 5,
    costUsd: '0.0000050000',
    finishReason: 'stop',
  });
  await upsertArrivalEmbedding({
    messageId: user.id,
    embedding: new Array<number>(1024).fill(0),
    modelId: EMBEDDING_MODEL_ID,
    embeddingCostUsd: 0.00000001,
  });
  await upsertSideCost({
    messageId: user.id,
    kind: 'rewrite',
    model: env.REWRITE_MODEL,
    costUsd: '0.0000002000',
  });
  await upsertSideCost({
    messageId: user.id,
    kind: 'judge',
    model: env.JUDGE_MODEL,
    costUsd: '0.0000003000',
  });
  await upsertSideCost({
    messageId: user.id,
    kind: 'fact_extraction',
    model: env.MEMORY_MODEL,
    costUsd: '0.0000004000',
  });
  await upsertSideCost({
    messageId: user.id,
    kind: 'fact_embedding',
    model: EMBEDDING_MODEL_ID,
    costUsd: '0.0000000500',
  });
}

describe('sumThreadSpend', () => {
  useTestDb();

  it('totals every spend source for one thread', async () => {
    const { threadId } = await createThread();
    await seedFullSpend(threadId);

    expect(await sumThreadSpend({ threadId })).toEqual({
      chat: '0.0000050000',
      embedding: '0.0000000100',
      rewrite: '0.0000002000',
      judge: '0.0000003000',
      memory: '0.0000004500',
    });
  });

  it('coalesces missing sources to zero and ignores other threads', async () => {
    const { threadId } = await createThread();
    const { threadId: otherThread } = await createThread();
    await seedFullSpend(otherThread);

    expect(await sumThreadSpend({ threadId })).toEqual(ZERO);

    // A thread with chat spend alone still bakes its zeros down flat.
    await insertMessage({ threadId, role: 'user', content: 'hi' });
    const assistant = await insertMessage({ threadId, role: 'assistant', content: 'yo' });
    await insertMessageUsage({
      messageId: assistant.id,
      model: 'provider/chat',
      providerId: randomUUID(),
      promptTokens: 1,
      completionTokens: 1,
      costUsd: '0.0000010000',
      finishReason: 'stop',
    });

    expect(await sumThreadSpend({ threadId })).toEqual({
      chat: '0.0000010000',
      embedding: '0.0000000000',
      rewrite: '0.0000000000',
      judge: '0.0000000000',
      memory: '0.0000000000',
    });
  });
});
