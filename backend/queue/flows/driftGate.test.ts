import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { whenArrivalJudged, whenJudgmentAbandoned } from '@queue/flows/driftGate';
import { judgeArrival } from '@queue/tasks/driftGateJudgeArrivalTask';
import { findMemoryCaptureSegmentJobOrNull } from '@queue/tasks/memoryCaptureSegmentTask';
import { queueTasks } from '@queue/worker';
import { subscribe } from '@services/events';
import { memoryOff, memoryOn } from '@test/memory';
import { drainQueue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';
import type { ServerEvent } from '../../src/types/events';

/**
 * The Drift gate's flow: verdicts announced and a fired arrival's closed
 * segment queued for capture, in that order.
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
});

afterAll(async () => {
  await mock.stop();
});

useTestDb();

function listen(userId: string, threadId: string) {
  events = [];
  unsubscribe = subscribe(userId, (event) => {
    if (event.threadId === threadId) events.push(event);
  }).close;
}

/** A thread with one settled Turn, and a second arrival on a new topic. */
async function threadWithShift() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId, title: 'Gate flow' });
  const opening = await insertMessage({
    threadId,
    role: 'user',
    content: 'I love hiking in the Alps',
  });
  await insertMessage({ threadId, role: 'assistant', content: 'The Alps are great for hiking.' });
  const shift = await insertMessage({
    threadId,
    role: 'user',
    content: 'Explain how espresso machines work',
  });
  return { userId, threadId, openingId: opening.id, shiftId: shift.id };
}

describe('whenArrivalJudged', () => {
  it('announces a clear verdict and nothing else', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId });
    const opening = await insertMessage({ threadId, role: 'user', content: 'Hello there' });
    const params = { userId, threadId, messageId: opening.id };
    listen(userId, threadId);

    await whenArrivalJudged({
      judgment: await judgeArrival({ arrival: params, threadAnalysisMode: 'heuristic' }),
      memory: memoryOn,
    });

    expect(events).toEqual([
      { kind: 'verdict-ok', userId, threadId, messageId: opening.id, verdict: 'muted' },
    ]);
  });

  it('queues the closed segment before announcing the pause, and the capture lands', async () => {
    const { userId, threadId, shiftId } = await threadWithShift();
    const params = { userId, threadId, messageId: shiftId };
    listen(userId, threadId);
    const judgment = await judgeArrival({ arrival: params, threadAnalysisMode: 'heuristic' });
    if (judgment.kind !== 'judged' || !judgment.closedSegment) {
      throw new Error('expected a fire with a closed segment');
    }
    const extractionsBefore = mock.memory.extractionCount();

    await whenArrivalJudged({ judgment, memory: memoryOn });

    // Queued before the announcement: the job is visible the moment the
    // pause event has flown.
    expect(events.map((event) => event.kind)).toEqual(['verdict-paused']);
    expect(events[0]).toMatchObject({ messageId: shiftId });
    expect(await findMemoryCaptureSegmentJobOrNull(judgment.closedSegment.segmentId)).toMatchObject(
      {
        state: 'queued',
      },
    );

    await drainQueue(queueTasks({ memory: memoryOn, threadAnalysisMode: 'heuristic' }));
    expect(await findMemoryCaptureSegmentJobOrNull(judgment.closedSegment.segmentId)).toBeNull();
    expect(mock.memory.extractionCount()).toBeGreaterThan(extractionsBefore);
    expect(events.at(-1)).toEqual({
      kind: 'memory-captured',
      userId,
      threadId,
      segmentId: judgment.closedSegment.segmentId,
    });
  });

  it('queues no capture without Memory, and still announces the pause', async () => {
    const { userId, threadId, shiftId } = await threadWithShift();
    const params = { userId, threadId, messageId: shiftId };
    listen(userId, threadId);
    const judgment = await judgeArrival({ arrival: params, threadAnalysisMode: 'heuristic' });
    if (judgment.kind !== 'judged' || !judgment.closedSegment) {
      throw new Error('expected a fire with a closed segment');
    }

    await whenArrivalJudged({ judgment, memory: memoryOff });

    expect(events.map((event) => event.kind)).toEqual(['verdict-paused']);
    expect(await findMemoryCaptureSegmentJobOrNull(judgment.closedSegment.segmentId)).toBeNull();
  });

  it('announces nothing for an arrival that is gone', async () => {
    const { userId, threadId } = await threadWithShift();
    listen(userId, threadId);

    await whenArrivalJudged({ judgment: { kind: 'gone' }, memory: memoryOn });

    expect(events).toEqual([]);
  });
});

describe('whenJudgmentAbandoned', () => {
  it('tells the waiting chat to retry', () => {
    const params = { userId: randomUUID(), threadId: randomUUID(), messageId: randomUUID() };
    listen(params.userId, params.threadId);

    whenJudgmentAbandoned(params);

    expect(events).toEqual([{ kind: 'gate-failed', ...params }]);
  });
});
