import { randomUUID } from 'node:crypto';
import { listStoredEmbeddings } from '@queries/messageEmbeddings/listStoredEmbeddings';
import { recordMessageEmbedding } from '@queries/messageEmbeddings/recordMessageEmbedding';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

const MODEL = 'model-a';
const vectorWith = (hot: number) =>
  Array.from({ length: 1024 }, (_, index) => (index === hot ? 1 : 0));

async function messagesOfOneThread(count: number) {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Stored embeddings' });
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const message = await insertMessage({
      threadId: thread.id,
      role: 'user',
      content: `m${index}`,
    });
    ids.push(message.id);
  }
  return ids;
}

describe('listStoredEmbeddings', () => {
  useTestDb();

  it('names every Message with an embedding, and sends the vectors of only those asked for', async () => {
    const [first, second, unembedded] = await messagesOfOneThread(3);
    await recordMessageEmbedding({
      messageId: first ?? '',
      embedding: vectorWith(0),
      modelId: MODEL,
    });
    await recordMessageEmbedding({
      messageId: second ?? '',
      embedding: vectorWith(1),
      modelId: MODEL,
    });

    const stored = await listStoredEmbeddings({
      messageIds: [first ?? '', second ?? '', unembedded ?? ''],
      vectorsFor: [second ?? ''],
      modelId: MODEL,
    });

    expect(stored).toHaveLength(2);
    expect(stored.find((row) => row.messageId === first)?.vectorOrNull).toBeNull();
    expect(stored.find((row) => row.messageId === second)?.vectorOrNull).toEqual(vectorWith(1));
  });

  it('reads only the model asked for, and nothing for no Messages', async () => {
    const [message] = await messagesOfOneThread(1);
    await recordMessageEmbedding({
      messageId: message ?? '',
      embedding: vectorWith(0),
      modelId: MODEL,
    });

    expect(
      await listStoredEmbeddings({
        messageIds: [message ?? ''],
        vectorsFor: [],
        modelId: 'model-b',
      }),
    ).toEqual([]);
    expect(await listStoredEmbeddings({ messageIds: [], vectorsFor: [], modelId: MODEL })).toEqual(
      [],
    );
    expect(
      await listStoredEmbeddings({ messageIds: [message ?? ''], vectorsFor: [], modelId: MODEL }),
    ).toEqual([{ messageId: message, vectorOrNull: null }]);
  });
});
