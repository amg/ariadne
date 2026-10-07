import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import { findSegmentDriftLogByMessageId } from '@queries/segmentDriftLogs/findSegmentDriftLogByMessageId';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  enqueueDriftGateJudgeArrival,
  findDriftGateJudgeArrivalJobOrNull,
} from '@queue/tasks/driftGateJudgeArrivalTask';
import { findMemoryCaptureSegmentJobOrNull } from '@queue/tasks/memoryCaptureSegmentTask';
import { EMBEDDING_MODEL_ID, isDriftPause, submitChat } from '@services/aiService';
import { handOverArrival } from '@services/handoverService';
import { createThread } from '@services/threadService';
import { memoryOff } from '@test/memory';
import { useTestQueue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { readUIMessageStream } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';

/**
 * A deployment without Memory, end to end with its worker running: the
 * chat, the pause and the handover all work, and none of them captures a
 * Fact or freezes a Seed with anything in it.
 */

let mock: MockInferenceServer;

beforeAll(async () => {
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterAll(async () => {
  await mock.stop();
});

useTestDb();
useTestQueue({ memory: memoryOff });

const judging = { enqueueDriftGateJudgeArrival, findDriftGateJudgeArrivalJobOrNull };
const titling = { enqueueThreadGenerateTitle: async () => {} };

function submit(props: { userId: string; threadId: string; content: string }) {
  return submitChat({ ...props, judging, titling, memory: memoryOff });
}

/** A thread with one settled Turn and a second arrival paused on a fire. */
async function pausedThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId, title: 'Without memory' });
  const opening = await submit({ userId, threadId, content: 'I love hiking in the Alps' });
  if (opening.type !== 'success' || isDriftPause(opening.data)) {
    throw new Error('the opening arrival must exchange');
  }
  for await (const _message of readUIMessageStream({ stream: opening.data.stream })) {
    // Consuming the stream lets the exchange settle.
  }
  await opening.data.outcome;

  const shift = await submit({ userId, threadId, content: 'Explain how espresso machines work' });
  if (shift.type !== 'success' || !isDriftPause(shift.data)) {
    throw new Error('the second arrival must pause');
  }
  const pausedMessageId = shift.data.threadVerdict.messageId;
  const logged = await findSegmentDriftLogByMessageId({
    messageId: pausedMessageId,
    modelId: EMBEDDING_MODEL_ID,
  });
  if (!logged) throw new Error('the fire must close a segment');
  return { userId, threadId, pausedMessageId, closedSegmentId: logged.segmentId };
}

async function factCountOf(userId: string): Promise<number> {
  const facts = await db
    .selectFrom('memory.userFacts')
    .select('id')
    .where('userId', '=', userId)
    .execute();
  return facts.length;
}

describe('a deployment without Memory', () => {
  it('queues no capture when a fire closes a segment', async () => {
    const extractions = mock.memory.extractionCount();
    const { userId, closedSegmentId } = await pausedThread();

    expect(await findMemoryCaptureSegmentJobOrNull(closedSegmentId)).toBeNull();
    expect(mock.memory.extractionCount()).toBe(extractions);
    expect(await factCountOf(userId)).toBe(0);
  });

  it('hands over at once, recording the move with a Seed that says nothing', async () => {
    const { userId, threadId, pausedMessageId, closedSegmentId } = await pausedThread();

    const result = await handOverArrival({
      userId,
      threadId,
      messageId: pausedMessageId,
      memory: memoryOff,
    });

    if (result.type !== 'success') throw new Error(`handover failed: ${result.code}`);
    const seed = await db
      .selectFrom('memory.threadSeeds')
      .select(['lines', 'factCount', 'handoverMessageId'])
      .where('threadId', '=', result.data.thread.id)
      .executeTakeFirstOrThrow();
    expect(seed).toEqual({ lines: [], factCount: 0, handoverMessageId: pausedMessageId });
    expect(await findMemoryCaptureSegmentJobOrNull(closedSegmentId)).toBeNull();
    expect(await factCountOf(userId)).toBe(0);
  });

  it('opens a Thread with no Seed', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });

    const thread = await createThread({ userId, memory: memoryOff });

    const seeds = await db
      .selectFrom('memory.threadSeeds')
      .select('threadId')
      .where('threadId', '=', thread.id)
      .execute();
    expect(seeds).toEqual([]);
  });
});
