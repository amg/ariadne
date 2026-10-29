import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { insertThreadSegment } from '@queries/threadSegments/insertThreadSegment';
import { listThreadSegmentsByThread } from '@queries/threadSegments/listThreadSegmentsByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

const MODEL_ID = 'test-model';

describe('setMessagesAbandoned', () => {
  useTestDb();

  it('deletes the segments that start at an abandoned message, and keeps the rest', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId });
    const opener = await insertMessage({ threadId, role: 'user', content: 'Hiking' });
    const fire = await insertMessage({ threadId, role: 'user', content: 'Espresso' });
    await insertThreadSegment({ threadId, startMessageId: opener.id, modelId: MODEL_ID });
    await insertThreadSegment({ threadId, startMessageId: fire.id, modelId: MODEL_ID });

    await setMessagesAbandoned({ messageIds: [fire.id], abandoned: true });

    const segments = await listThreadSegmentsByThread({ threadId, modelId: MODEL_ID });
    expect(segments.map((segment) => segment.startMessageId)).toEqual([opener.id]);
  });

  it('leaves segments alone when it makes a message live again', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId });
    const opener = await insertMessage({ threadId, role: 'user', content: 'Hiking' });
    await insertThreadSegment({ threadId, startMessageId: opener.id, modelId: MODEL_ID });

    await setMessagesAbandoned({ messageIds: [opener.id], abandoned: false });

    const segments = await listThreadSegmentsByThread({ threadId, modelId: MODEL_ID });
    expect(segments.map((segment) => segment.startMessageId)).toEqual([opener.id]);
  });
});
