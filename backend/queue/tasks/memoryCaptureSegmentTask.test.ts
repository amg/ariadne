import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertSegmentDriftLog } from '@queries/segmentDriftLogs/insertSegmentDriftLog';
import { insertThreadSegment } from '@queries/threadSegments/insertThreadSegment';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  enqueueMemoryCaptureSegment,
  findMemoryCaptureSegmentJobOrNull,
} from '@queue/tasks/memoryCaptureSegmentTask';
import { queueTasks } from '@queue/worker';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { subscribe } from '@services/events';
import { memoryOn } from '@test/memory';
import { drainQueue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';
import type { ServerEvent } from '../../src/types/events';

/**
 * A segment's capture on the worker: what it announces, and how its
 * failures are classed — retried when a retry can help, given up at once
 * when only the operator can.
 */

let mock: MockInferenceServer;
let events: ServerEvent[] = [];
let unsubscribe: () => void = () => {};

beforeAll(async () => {
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterEach(() => {
  unsubscribe();
  mock.memory.clearFailures();
});

afterAll(async () => {
  await mock.stop();
});

useTestDb();

/** A thread whose first segment holds one Turn and was closed by a fire. */
async function closedSegment() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId, title: 'Capture task' });
  const opening = await insertMessage({ threadId, role: 'user', content: 'I love jazz' });
  await insertMessage({ threadId, role: 'assistant', content: 'Noted.' });
  const boundary = await insertMessage({ threadId, role: 'user', content: 'Another topic' });
  const segment = await insertThreadSegment({
    threadId,
    startMessageId: opening.id,
    modelId: EMBEDDING_MODEL_ID,
  });
  await insertSegmentDriftLog({
    segmentId: segment.id,
    messageId: boundary.id,
    modelId: EMBEDDING_MODEL_ID,
    verdict: 'fire',
    fireChannel: 'immediate',
  });
  await insertThreadSegment({ threadId, startMessageId: boundary.id, modelId: EMBEDDING_MODEL_ID });
  events = [];
  unsubscribe = subscribe(userId, (event) => {
    if (event.threadId === threadId) events.push(event);
  }).close;
  return { userId, threadId, segmentId: segment.id };
}

describe('memoryCaptureSegment on the worker', () => {
  it('announces a capture that landed', async () => {
    const segment = await closedSegment();

    await enqueueMemoryCaptureSegment(segment);
    await drainQueue(queueTasks({ memory: memoryOn, threadAnalysisMode: 'heuristic' }));

    expect(events).toEqual([{ kind: 'memory-captured', ...segment }]);
    expect(await findMemoryCaptureSegmentJobOrNull(segment.segmentId)).toBeNull();
  });

  it('keeps a failed read for another attempt, announcing nothing yet', async () => {
    const segment = await closedSegment();
    mock.memory.failExtractions();

    await enqueueMemoryCaptureSegment(segment);
    await drainQueue(queueTasks({ memory: memoryOn, threadAnalysisMode: 'heuristic' }));

    expect(events).toEqual([]);
    expect(await findMemoryCaptureSegmentJobOrNull(segment.segmentId)).toMatchObject({
      state: 'queued',
      errorClass: 'recoverable',
    });
  });

  it('gives up at once without a configured provider, and announces it', async () => {
    const segment = await closedSegment();
    const savedUrl = process.env.MOCK_AI_BASE_URL;
    const savedKey = process.env.DEEPINFRA_API_KEY;
    process.env.MOCK_AI_BASE_URL = '';
    process.env.DEEPINFRA_API_KEY = '';
    try {
      await enqueueMemoryCaptureSegment(segment);
      await drainQueue(queueTasks({ memory: memoryOn, threadAnalysisMode: 'heuristic' }));
    } finally {
      process.env.MOCK_AI_BASE_URL = savedUrl ?? '';
      process.env.DEEPINFRA_API_KEY = savedKey ?? '';
    }

    expect(events).toEqual([{ kind: 'memory-capture-failed', ...segment }]);
    expect(await findMemoryCaptureSegmentJobOrNull(segment.segmentId)).toMatchObject({
      state: 'dead',
      errorClass: 'fatal',
    });
  });
});
