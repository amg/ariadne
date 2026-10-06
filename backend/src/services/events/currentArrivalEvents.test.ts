import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  DRIFT_GATE_JUDGE_ARRIVAL,
  enqueueDriftGateJudgeArrival,
  findDriftGateJudgeArrivalJobOrNull,
} from '@queue/tasks/driftGateJudgeArrivalTask';
import { isDriftPause, submitChat } from '@services/aiService';
import { currentArrivalEvents } from '@services/events';
import { addDeadJob, useTestQueue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { readUIMessageStream } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../../mock/inferenceServer';

/**
 * The current state of a user's arrivals rendered as ordinary events,
 * end to end with the worker running in this process. The mock embeds
 * every distinct text far apart, so a thread's second arrival always
 * fires.
 */

let mock: MockInferenceServer;
const savedGateWait = process.env.GATE_WAIT_MS;

beforeAll(async () => {
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterEach(() => {
  process.env.GATE_WAIT_MS = savedGateWait ?? '';
});

afterAll(async () => {
  await mock.stop();
});

useTestDb();
useTestQueue();

const judging = { enqueueDriftGateJudgeArrival, findDriftGateJudgeArrivalJobOrNull };

async function freshThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId, title: 'Arrival states' });
  return { userId, threadId };
}

/** One more thread for an existing user. */
async function freshThreadWithUser(userId: string): Promise<string> {
  const { id: threadId } = await insertThread({ userId, title: 'Arrival states' });
  return threadId;
}

/** Consumes the exchange's stream so it settles, leaving the arrival answered. */
async function drained(result: Awaited<ReturnType<typeof submitChat>>): Promise<void> {
  if (result.type !== 'success' || isDriftPause(result.data)) {
    throw new Error(`expected an exchange, got ${JSON.stringify(result)}`);
  }
  for await (const _message of readUIMessageStream({ stream: result.data.stream })) {
    // Consuming the stream lets the exchange settle.
  }
  await result.data.outcome;
}

/** Resolves once the arrival's judgment has finished, successfully or not. */
async function judgmentSettled(messageId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const job = await findDriftGateJudgeArrivalJobOrNull(messageId);
    if (job === null || job.state === 'dead') return;
    if (Date.now() > deadline) throw new Error('the judgment never settled');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function newestArrivalId(threadId: string): Promise<string> {
  const rows = await listMessagesByThread({ threadId });
  const row = rows.filter((r) => r.role === 'user' && !r.abandoned).at(-1);
  if (!row) throw new Error('no arrival found');
  return row.id;
}

describe('the current state of a user\u2019s arrivals', () => {
  it('reports nothing for a thread whose last arrival is answered', async () => {
    const { userId, threadId } = await freshThread();
    await drained(await submitChat({ userId, threadId, content: 'A plain question', judging }));

    expect(await currentArrivalEvents(userId)).toEqual([]);
  });

  it('reports a judged-clear arrival that nobody waited for', async () => {
    const { userId, threadId } = await freshThread();
    process.env.GATE_WAIT_MS = '0';

    const pending = await submitChat({ userId, threadId, content: 'Left hanging', judging });
    expect(pending).toMatchObject({ type: 'error', code: 'gate_pending' });

    const arrivalId = await newestArrivalId(threadId);
    await judgmentSettled(arrivalId);

    expect(await currentArrivalEvents(userId)).toEqual([
      { kind: 'verdict-ok', userId, threadId, messageId: arrivalId, verdict: 'muted' },
    ]);
  });

  it('reports a Paused arrival with its fire', async () => {
    const { userId, threadId } = await freshThread();
    await drained(
      await submitChat({ userId, threadId, content: 'I love hiking in the Alps', judging }),
    );
    const shift = await submitChat({
      userId,
      threadId,
      content: 'Explain how espresso machines work',
      judging,
    });
    if (shift.type !== 'success' || !isDriftPause(shift.data)) {
      throw new Error('the second arrival must pause');
    }
    const pausedId = shift.data.threadVerdict.messageId;

    const events = await currentArrivalEvents(userId);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'verdict-paused',
      userId,
      threadId,
      messageId: pausedId,
    });
  });

  it('reports an arrival whose judgment died fatally, and not one that still owes its judgment', async () => {
    const { userId, threadId } = await freshThread();
    const dead = await insertMessage({ threadId, role: 'user', content: 'Died on the gate' });
    await addDeadJob({
      task: DRIFT_GATE_JUDGE_ARRIVAL,
      key: dead.id,
      payload: { userId, threadId, messageId: dead.id },
      errorClass: 'fatal',
    });

    const fresh = await freshThreadWithUser(userId);
    await insertMessage({ threadId: fresh, role: 'user', content: 'From before the queue' });

    expect(await currentArrivalEvents(userId)).toEqual([
      { kind: 'gate-failed', userId, threadId, messageId: dead.id },
    ]);
  });

  it('reports nothing for an arrival that predates the queue and holds no verdict', async () => {
    const { userId, threadId } = await freshThread();
    await insertMessage({ threadId, role: 'user', content: 'From before the queue' });

    expect(await currentArrivalEvents(userId)).toEqual([]);
  });

  it('never reports another user\u2019s arrivals', async () => {
    const stranger = await freshThread();
    await drained(
      await submitChat({
        userId: stranger.userId,
        threadId: stranger.threadId,
        content: 'I love hiking in the Alps too',
        judging,
      }),
    );
    await submitChat({
      userId: stranger.userId,
      threadId: stranger.threadId,
      content: 'Explain how espresso machines work',
      judging,
    });

    const { userId } = await freshThread();

    expect(await currentArrivalEvents(userId)).toEqual([]);
  });
});
