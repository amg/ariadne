import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import { recordMessageEmbedding } from '@queries/messageEmbeddings/recordMessageEmbedding';
import { addSideCost } from '@queries/messageSideCosts/addSideCost';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { sumDailySpend } from '@queries/messageUsage/sumDailySpend';
import { insertMessage } from '@queries/messages/insertMessage';
import { deleteThread } from '@queries/threads/deleteThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService/config';
import { useTestDb } from '@test/test-db';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

async function createThread(): Promise<{ userId: string; threadId: string }> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Spend thread' });
  return { userId, threadId: thread.id };
}

async function seedChatSpend(threadId: string, costUsd: string) {
  await insertMessage({ threadId, role: 'user', content: 'hello' });
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

/** The slots of today's spend that hold anything, in order. */
async function slotsHoldingToday() {
  const rows = await db
    .selectFrom('billing.dailySpend')
    .select('slot')
    .where('day', '=', sql<Date>`(now() at time zone 'UTC')::date`)
    .orderBy('slot')
    .execute();
  return rows.map((row) => row.slot);
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
    await recordMessageEmbedding({
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

  it('counts spend added to rows that already exist', async () => {
    const { threadId } = await createThread();
    const user = await insertMessage({ threadId, role: 'user', content: 'test' });
    const sideCost: Omit<Parameters<typeof addSideCost>[0], 'costUsd'> = {
      messageId: user.id,
      kind: 'judge',
      model: 'test-model',
      promptTokens: null,
      completionTokens: null,
    };
    const arrivalEmbedding = {
      messageId: user.id,
      embedding: new Array<number>(1024).fill(0),
      modelId: EMBEDDING_MODEL_ID,
    };

    await addSideCost({ ...sideCost, costUsd: '0.0000003000' });
    await addSideCost({ ...sideCost, costUsd: '0.0000004000' });
    await recordMessageEmbedding({ ...arrivalEmbedding, embeddingCostUsd: 0.0000001 });
    await recordMessageEmbedding({ ...arrivalEmbedding, embeddingCostUsd: 0.0000002 });

    expect(await sumDailySpend()).toBe('0.0000010000');
  });

  it('keeps the spend of deleted threads', async () => {
    const { userId, threadId } = await createThread();
    await seedChatSpend(threadId, '0.0000010000');

    await deleteThread({ userId, threadId });

    expect(await sumDailySpend()).toBe('0.0000010000');
  });

  it('leaves out spend recorded on earlier days', async () => {
    const { threadId } = await createThread();
    await seedChatSpend(threadId, '0.0000010000');
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await db
      .insertInto('billing.dailySpend')
      .values({ day: yesterday, costUsd: '5.0000000000' })
      .execute();

    expect(await sumDailySpend()).toBe('0.0000010000');
  });

  it('spreads spend over several rows, and the day’s total stays their sum', async () => {
    const { threadId } = await createThread();
    const user = await insertMessage({ threadId, role: 'user', content: 'test' });

    for (let spender = 0; spender < 40; spender += 1) {
      await addSideCost({
        messageId: user.id,
        kind: 'judge',
        model: `model-${spender}`,
        costUsd: '0.0000001000',
        promptTokens: null,
        completionTokens: null,
      });
    }

    expect((await slotsHoldingToday()).length).toBeGreaterThan(1);
    expect(await sumDailySpend()).toBe('0.0000040000');
  });

  it('keeps everything one transaction spends in one row, so it never holds two', async () => {
    const { threadId } = await createThread();
    const user = await insertMessage({ threadId, role: 'user', content: 'test' });
    const assistant = await insertMessage({ threadId, role: 'assistant', content: 'hi' });

    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('billing.messageUsage')
        .values({
          messageId: assistant.id,
          model: 'provider/chat',
          providerId: randomUUID(),
          promptTokens: 10,
          completionTokens: 5,
          costUsd: '0.0000010000',
          finishReason: 'stop',
        })
        .execute();
      for (const kind of ['rewrite', 'judge'] as const) {
        await trx
          .insertInto('billing.messageSideCosts')
          .values({
            messageId: user.id,
            kind,
            model: 'test-model',
            costUsd: '0.0000002000',
            promptTokens: null,
            completionTokens: null,
          })
          .execute();
      }
    });

    expect(await slotsHoldingToday()).toHaveLength(1);
    expect(await sumDailySpend()).toBe('0.0000014000');
  });
});
