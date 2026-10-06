import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import { insertMessage } from '@queries/messages/insertMessage';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { deleteThread } from '@queries/threads/deleteThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { TaskFailure, classifyTaskError } from '@queue/errors';
import {
  enqueueDriftGateJudgeArrival,
  findDriftGateJudgeArrivalJobOrNull,
  judgeArrival,
} from '@queue/tasks/driftGateJudgeArrivalTask';
import { queueTasks } from '@queue/worker';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { type ServerEvent, subscribe } from '@services/events';
import { drainQueue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';

/**
 * The mock embeds every distinct text far apart, so a second arrival after
 * one settled Turn always fires the gate.
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

/** A thread with one settled Turn, and a second arrival on a new topic. */
async function threadWithShift() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId, title: 'Gate task' });
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

async function chainRowCounts(threadId: string) {
  const [logs, segments, embeddings] = await Promise.all([
    db
      .selectFrom('segmentDriftLogs as l')
      .innerJoin('messages as m', 'm.id', 'l.messageId')
      .where('m.threadId', '=', threadId)
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('threadSegments')
      .where('threadId', '=', threadId)
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('messageEmbeddings as e')
      .innerJoin('messages as m', 'm.id', 'e.messageId')
      .where('m.threadId', '=', threadId)
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow(),
  ]);
  return { logs: logs.n, segments: segments.n, embeddings: embeddings.n };
}

describe('judgeArrival', () => {
  it('clears an opening arrival', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId });
    const opening = await insertMessage({ threadId, role: 'user', content: 'Hello there' });

    const judgment = await judgeArrival({ userId, threadId, messageId: opening.id });

    expect(judgment).toMatchObject({ kind: 'judged', verdict: 'muted', closedSegment: null });
  });

  it('fires on a shifted arrival and names the closed segment', async () => {
    const { userId, threadId, shiftId } = await threadWithShift();

    const judgment = await judgeArrival({ userId, threadId, messageId: shiftId });

    expect(judgment).toMatchObject({ kind: 'judged', verdict: 'fire' });
    expect(judgment.kind === 'judged' && judgment.verdict === 'fire').toBe(true);
    if (judgment.kind !== 'judged') throw new Error('expected a judgment');
    expect(['immediate', 'slow']).toContain(judgment.fireChannel);
    expect(judgment.closedSegment).toMatchObject({ userId, threadId });
    const segment = judgment.closedSegment;
    if (!segment) throw new Error('expected a closed segment');
    expect(segment.segmentId).not.toBe('');
  });

  it('leaves the database as it was when judging a second time', async () => {
    const { userId, threadId, shiftId } = await threadWithShift();
    const params = { userId, threadId, messageId: shiftId };
    await judgeArrival(params);
    const once = await chainRowCounts(threadId);
    const embedsOnce = mock.embeddings.requestCount();

    const again = await judgeArrival(params);

    expect(await chainRowCounts(threadId)).toEqual(once);
    expect(mock.embeddings.requestCount()).toBe(embedsOnce);
    expect(again).toMatchObject({ kind: 'judged', verdict: 'fire', messageId: shiftId });
  });

  it('reports an abandoned arrival and a deleted thread gone', async () => {
    const first = await threadWithShift();
    await setMessagesAbandoned({ messageIds: [first.shiftId], abandoned: true });
    const second = await threadWithShift();
    await deleteThread({ userId: second.userId, threadId: second.threadId });

    expect(
      await judgeArrival({
        userId: first.userId,
        threadId: first.threadId,
        messageId: first.shiftId,
      }),
    ).toEqual({ kind: 'gone' });
    expect(
      await judgeArrival({
        userId: second.userId,
        threadId: second.threadId,
        messageId: second.shiftId,
      }),
    ).toEqual({ kind: 'gone' });
    expect(await chainRowCounts(first.threadId)).toMatchObject({ logs: '0' });
  });

  it('fails recoverably when the provider does', async () => {
    const { userId, threadId, shiftId } = await threadWithShift();
    mock.embeddings.failFrom(mock.embeddings.requestCount() + 1);
    try {
      const failure = await judgeArrival({ userId, threadId, messageId: shiftId }).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(TaskFailure);
      expect(classifyTaskError(failure)).toBe('recoverable');
    } finally {
      mock.embeddings.clearFailures();
    }
  });
});

describe('driftGateJudgeArrival on the worker', () => {
  it('announces the gate failed when it cannot judge at all, and stays dead', async () => {
    const { userId, threadId, shiftId } = await threadWithShift();
    const events: ServerEvent[] = [];
    const unsubscribe = subscribe(
      (event) => event.threadId === threadId,
      (event) => events.push(event),
    );
    const savedUrl = process.env.MOCK_AI_BASE_URL;
    const savedKey = process.env.DEEPINFRA_API_KEY;
    process.env.MOCK_AI_BASE_URL = '';
    process.env.DEEPINFRA_API_KEY = '';
    try {
      await enqueueDriftGateJudgeArrival({ userId, threadId, messageId: shiftId });
      await drainQueue(queueTasks());
    } finally {
      process.env.MOCK_AI_BASE_URL = savedUrl ?? '';
      process.env.DEEPINFRA_API_KEY = savedKey ?? '';
      unsubscribe();
    }

    expect(events).toEqual([{ kind: 'gate-failed', userId, threadId, messageId: shiftId }]);
    expect(await findDriftGateJudgeArrivalJobOrNull(shiftId)).toMatchObject({
      state: 'dead',
      errorClass: 'fatal',
    });
  });

  it('judges a queued arrival once, however often it was queued while waiting', async () => {
    const { userId, threadId, shiftId } = await threadWithShift();
    const events: ServerEvent[] = [];
    const unsubscribe = subscribe(
      (event) => event.threadId === threadId,
      (event) => events.push(event),
    );
    try {
      await enqueueDriftGateJudgeArrival({ userId, threadId, messageId: shiftId });
      await enqueueDriftGateJudgeArrival({ userId, threadId, messageId: shiftId });
      await drainQueue(queueTasks());
    } finally {
      unsubscribe();
    }

    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ kind: 'verdict-paused', messageId: shiftId });
    expect(await findDriftGateJudgeArrivalJobOrNull(shiftId)).toBeNull();
  });
});
