import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertSegmentDriftLog } from '@queries/segmentDriftLogs/insertSegmentDriftLog';
import { insertThreadSegment } from '@queries/threadSegments/insertThreadSegment';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  captureMemorySegment,
  enqueueMemoryCaptureSegment,
  findMemoryCaptureSegmentJobOrNull,
} from '@queue/tasks/memoryCaptureSegmentTask';
import { queueTasks } from '@queue/worker';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { subscribe } from '@services/events';
import { memoryOn } from '@test/memory';
import { drainQueue } from '@test/queue';
import { sideCostsOfThread } from '@test/sideCosts';
import { useStoppableWrites } from '@test/stoppedWrites';
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
const stopWritesTo = useStoppableWrites();

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

/** The Facts stored for the user, in a stable order. */
async function factsOf(userId: string) {
  const rows = await db
    .selectFrom('memory.userFacts')
    .where('userId', '=', userId)
    .select(['content', 'category'])
    .execute();
  return rows.sort((a, b) => a.content.localeCompare(b.content));
}

/** What the thread's capture calls were paid for, summed per kind. */
async function paidTokensByKind(threadId: string) {
  const paid = new Map<string, number>();
  for (const row of await sideCostsOfThread(threadId)) {
    paid.set(row.kind, (paid.get(row.kind) ?? 0) + (row.promptTokens ?? 0));
  }
  return paid;
}

describe('captureMemorySegment run again', () => {
  it('stores nothing extra and reads nothing once its segment is captured', async () => {
    const segment = await closedSegment();
    await captureMemorySegment(segment);
    const facts = await factsOf(segment.userId);
    expect(facts.length).toBeGreaterThan(0);
    const spend = await sideCostsOfThread(segment.threadId);
    const extractions = mock.memory.extractionCount();

    await captureMemorySegment(segment);

    expect(await factsOf(segment.userId)).toEqual(facts);
    expect(await sideCostsOfThread(segment.threadId)).toEqual(spend);
    expect(mock.memory.extractionCount()).toBe(extractions);
  });

  it('stores its Facts once, and records the spend of both reads, after stopping before its pointer moved', async () => {
    const uninterrupted = await closedSegment();
    await captureMemorySegment(uninterrupted);
    const facts = await factsOf(uninterrupted.userId);
    const paidOnce = await paidTokensByKind(uninterrupted.threadId);

    const segment = await closedSegment();
    const release = await stopWritesTo('memory.memory_capture_progress');
    const stopped = await captureMemorySegment(segment).catch((error: unknown) => error);
    await release();
    expect(stopped).toBeInstanceOf(Error);
    // The Facts and the pointer commit together, so the stop left no Fact behind.
    expect(await factsOf(segment.userId)).toEqual([]);

    await captureMemorySegment(segment);

    expect(await factsOf(segment.userId)).toEqual(facts);
    // Both reads really paid their provider, and each is on the record.
    const paidTwice = await paidTokensByKind(segment.threadId);
    expect([...paidTwice.keys()].sort()).toEqual([...paidOnce.keys()].sort());
    for (const [kind, tokens] of paidOnce) expect(paidTwice.get(kind)).toBe(tokens * 2);
  });
});
