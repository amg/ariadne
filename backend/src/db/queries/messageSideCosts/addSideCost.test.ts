import { randomUUID } from 'node:crypto';
import { addSideCost } from '@queries/messageSideCosts/addSideCost';
import { getSideCostByMessageId } from '@queries/messageSideCosts/getSideCostByMessageId';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createMessage(): Promise<string> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Side cost thread' });
  const message = await insertMessage({ threadId: thread.id, role: 'user', content: 'hi' });
  return message.id;
}

async function stored(messageId: string) {
  const row = await getSideCostByMessageId({ messageId, kind: 'fact_extraction', model: 'm' });
  return (
    row && {
      costUsd: Number(row.costUsd),
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
    }
  );
}

function cost(messageId: string, costUsd: string, tokens: number | null) {
  return {
    messageId,
    kind: 'fact_extraction' as const,
    model: 'm',
    costUsd,
    promptTokens: tokens,
    completionTokens: tokens,
  };
}

describe('addSideCost', () => {
  useTestDb();

  it('creates the row on first use and adds later runs to it', async () => {
    const messageId = await createMessage();

    await addSideCost(cost(messageId, '0.0000001000', 10));
    await addSideCost(cost(messageId, '0.0000002000', 5));

    expect(await stored(messageId)).toEqual({
      costUsd: 0.0000003,
      promptTokens: 15,
      completionTokens: 15,
    });
  });

  it('keeps a known token count when an unknown one is added', async () => {
    const messageId = await createMessage();

    await addSideCost(cost(messageId, '0.0000001000', 10));
    await addSideCost(cost(messageId, '0.0000001000', null));

    expect(await stored(messageId)).toMatchObject({ promptTokens: 10, completionTokens: 10 });
  });

  it('takes the added count when the stored one is unknown', async () => {
    const messageId = await createMessage();
    await addSideCost(cost(messageId, '0.0000001000', null));

    await addSideCost(cost(messageId, '0.0000001000', 7));

    expect(await stored(messageId)).toMatchObject({
      costUsd: 0.0000002,
      promptTokens: 7,
      completionTokens: 7,
    });
  });

  it('leaves two unknown counts unknown', async () => {
    const messageId = await createMessage();

    await addSideCost(cost(messageId, '0.0000001000', null));
    await addSideCost(cost(messageId, '0.0000001000', null));

    expect(await stored(messageId)).toMatchObject({ promptTokens: null, completionTokens: null });
  });

  it.each(['NaN', 'Infinity', '-0.0000001000', '', 'abc'])(
    'rejects the cost %j and stores nothing',
    async (bad) => {
      const messageId = await createMessage();

      await expect(addSideCost(cost(messageId, bad, 1))).rejects.toThrow('invalid costUsd');

      expect(await stored(messageId)).toBeUndefined();
    },
  );
});
