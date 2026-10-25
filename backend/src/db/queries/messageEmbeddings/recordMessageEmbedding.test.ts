import { randomUUID } from 'node:crypto';
import { listMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/listMessageEmbeddingsByMessageIds';
import { recordMessageEmbedding } from '@queries/messageEmbeddings/recordMessageEmbedding';
import { getSideCostByMessageId } from '@queries/messageSideCosts/getSideCostByMessageId';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

/**
 * One embedding row per Message and model, and spend that always counts:
 * the first pass's vector stands for every pass, a second model starts
 * its own row, and every pass that paid accumulates its spend — onto the
 * model's own side-cost row.
 */

const UNIT = Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0));
const OTHER = Array.from({ length: 1024 }, (_, index) => (index === 1 ? 1 : 0));

async function createMessage() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Embedding keys' });
  const message = await insertMessage({
    threadId: thread.id,
    role: 'user',
    content: 'hi',
  });
  return message.id;
}

async function embeddingSpend(messageId: string, model: string) {
  const row = await getSideCostByMessageId({
    messageId,
    kind: 'embedding',
    model,
  });
  return row ? Number(row.costUsd) : null;
}

describe('recordMessageEmbedding', () => {
  useTestDb();

  it('stores the first pass’s vector and stands for every later pass', async () => {
    const messageId = await createMessage();

    const first = await recordMessageEmbedding({
      messageId,
      embedding: UNIT,
      modelId: 'seed/embed-a',
      embeddingCostUsd: 0.00000001,
      promptTokens: 10,
    });
    expect(first.embedding).toEqual(UNIT);

    const second = await recordMessageEmbedding({
      messageId,
      embedding: OTHER,
      modelId: 'seed/embed-a',
      embeddingCostUsd: 0.00000001,
      promptTokens: 10,
    });
    // The stored vector is the first one; the later pass only paid.
    expect(second.embedding).toEqual(UNIT);
    expect(await embeddingSpend(messageId, 'seed/embed-a')).toBeCloseTo(0.00000002, 10);

    const rows = await listMessageEmbeddingsByMessageIds({
      messageIds: [messageId],
      modelId: 'seed/embed-a',
    });
    expect(rows).toHaveLength(1);
  });

  it('starts its own row for another model, spend tracked apart', async () => {
    const messageId = await createMessage();

    await recordMessageEmbedding({
      messageId,
      embedding: UNIT,
      modelId: 'seed/embed-a',
      embeddingCostUsd: 0.00000001,
      promptTokens: 10,
    });
    await recordMessageEmbedding({
      messageId,
      embedding: OTHER,
      modelId: 'seed/embed-b',
      embeddingCostUsd: 0.00000002,
      promptTokens: 10,
    });

    const rows = await listMessageEmbeddingsByMessageIds({
      messageIds: [messageId],
      modelId: 'seed/embed-b',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.embedding).toEqual(OTHER);

    expect(await embeddingSpend(messageId, 'seed/embed-a')).toBeCloseTo(0.00000001, 10);
    expect(await embeddingSpend(messageId, 'seed/embed-b')).toBeCloseTo(0.00000002, 10);
  });

  it('records no spend when the caller had none', async () => {
    const messageId = await createMessage();

    await recordMessageEmbedding({
      messageId,
      embedding: UNIT,
      modelId: 'seed/embed-a',
    });

    expect(await embeddingSpend(messageId, 'seed/embed-a')).toBeNull();
  });
});
