import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { requeueDeadJobs } from '@queue/deadJobs';
import {
  DRIFT_GATE_JUDGE_ARRIVAL,
  enqueueDriftGateJudgeArrival,
  findDriftGateJudgeArrivalJobOrNull,
} from '@queue/tasks/driftGateJudgeArrivalTask';
import {
  type ChatStreamHandle,
  type RetryChoice,
  isDriftPause,
  retryLastExchange,
  submitChat,
} from '@services/aiService';
import { memoryOn } from '@test/memory';
import { addDeadJob, useTestQueue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { readUIMessageStream } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';

/**
 * The chat request holding for the Drift gate's verdict, end to end with
 * the worker running in this process. The mock embeds every distinct text
 * far apart, so the second arrival of a thread always fires.
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
useTestQueue({ memory: memoryOn });

const judging = { enqueueDriftGateJudgeArrival, findDriftGateJudgeArrivalJobOrNull };
/** This suite asserts verdict waits, not titles: settlement never asks for one. */
const titling = { enqueueThreadGenerateTitle: async () => {} };

function submit(
  props: { userId: string; threadId: string; content: string },
  signal?: AbortSignal,
) {
  return submitChat({
    ...props,
    judging,
    titling,
    memory: memoryOn,
    ...(signal ? { signal } : {}),
  });
}

function retry(props: { userId: string; threadId: string }, choice: RetryChoice = 'retry') {
  return retryLastExchange({ ...props, choice, judging, titling, memory: memoryOn });
}

async function freshThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId, title: 'Gate wait' });
  return { userId, threadId };
}

async function drained(result: Awaited<ReturnType<typeof submitChat>>): Promise<ChatStreamHandle> {
  if (result.type !== 'success' || isDriftPause(result.data)) {
    throw new Error(`expected an exchange, got ${JSON.stringify(result)}`);
  }
  for await (const _message of readUIMessageStream({ stream: result.data.stream })) {
    // Consuming the stream lets the exchange settle.
  }
  await result.data.outcome;
  return result.data;
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

async function verdictCount(messageId: string): Promise<number> {
  const rows = await db
    .selectFrom('analysis.segmentDriftLogs')
    .select('id')
    .where('messageId', '=', messageId)
    .execute();
  return rows.length;
}

async function newestUserRow(threadId: string) {
  const rows = await listMessagesByThread({ threadId });
  const row = rows.filter((r) => r.role === 'user' && !r.abandoned).at(-1);
  if (!row) throw new Error('no user row');
  return row;
}

describe('the chat request waiting on the gate', () => {
  it('answers "still checking" past the wait, keeps the arrival, and replies on retry without judging again', async () => {
    const { userId, threadId } = await freshThread();
    process.env.GATE_WAIT_MS = '0';

    const pending = await submit({ userId, threadId, content: 'Is anyone there?' });

    expect(pending).toMatchObject({ type: 'error', code: 'gate_pending' });
    const arrival = await newestUserRow(threadId);
    expect(arrival.content).toBe('Is anyone there?');

    await judgmentSettled(arrival.id);
    process.env.GATE_WAIT_MS = '10000';
    const embedsBefore = mock.embeddings.requestCount();
    const reply = await drained(await retry({ userId, threadId }));

    expect(reply.threadVerdict).toMatchObject({ messageId: arrival.id, verdict: 'muted' });
    expect(await verdictCount(arrival.id)).toBe(1);
    expect(mock.embeddings.requestCount()).toBe(embedsBefore);
  });

  it('starts no reply when the client leaves mid-wait, yet the verdict still lands', async () => {
    const { userId, threadId } = await freshThread();
    const gone = new AbortController();
    gone.abort();

    const result = await submit({ userId, threadId, content: 'Closing the tab now' }, gone.signal);

    expect(result).toMatchObject({ type: 'error', code: 'gate_pending' });
    const arrival = await newestUserRow(threadId);
    await judgmentSettled(arrival.id);
    expect(await verdictCount(arrival.id)).toBe(1);
    const rows = await listMessagesByThread({ threadId });
    expect(rows.map((row) => row.role)).toEqual(['user']);
  });

  it('refuses a further submit while the last arrival is unanswered', async () => {
    const { userId, threadId } = await freshThread();
    await insertMessage({ threadId, role: 'user', content: 'An arrival nobody answered' });

    const next = await submit({ userId, threadId, content: 'And another thing' });

    expect(next).toMatchObject({ type: 'error', code: 'arrival_unanswered' });
  });
});

describe('retrying an arrival with no reply', () => {
  it('judges an arrival that was never queued, then replies', async () => {
    const { userId, threadId } = await freshThread();
    const arrival = await insertMessage({
      threadId,
      role: 'user',
      content: 'From before the queue',
    });

    const reply = await drained(await retry({ userId, threadId }));

    expect(reply.threadVerdict?.messageId).toBe(arrival.id);
    expect(await verdictCount(arrival.id)).toBe(1);
  });

  it('queues a judgment that gave up on recoverable failures again, then replies', async () => {
    const { userId, threadId } = await freshThread();
    const arrival = await insertMessage({ threadId, role: 'user', content: 'The model was cold' });
    await addDeadJob({
      task: DRIFT_GATE_JUDGE_ARRIVAL,
      key: arrival.id,
      payload: { userId, threadId, messageId: arrival.id },
      errorClass: 'recoverable',
    });

    const reply = await drained(await retry({ userId, threadId }));

    expect(reply.threadVerdict?.messageId).toBe(arrival.id);
  });

  it('answers gate_failed while the judgment is dead on a fatal failure', async () => {
    const { userId, threadId } = await freshThread();
    const arrival = await insertMessage({ threadId, role: 'user', content: 'Misconfigured' });
    await addDeadJob({
      task: DRIFT_GATE_JUDGE_ARRIVAL,
      key: arrival.id,
      payload: { userId, threadId, messageId: arrival.id },
      errorClass: 'fatal',
    });

    expect(await retry({ userId, threadId })).toMatchObject({ type: 'error', code: 'gate_failed' });
    expect(await verdictCount(arrival.id)).toBe(0);
  });

  it('replies once the operator re-queues the fatally dead judgment', async () => {
    const { userId, threadId } = await freshThread();
    const arrival = await insertMessage({ threadId, role: 'user', content: 'Fixed config' });
    await addDeadJob({
      task: DRIFT_GATE_JUDGE_ARRIVAL,
      key: arrival.id,
      payload: { userId, threadId, messageId: arrival.id },
      errorClass: 'fatal',
    });

    await requeueDeadJobs();
    const reply = await drained(await retry({ userId, threadId }));

    expect(reply.threadVerdict?.messageId).toBe(arrival.id);
    expect(await verdictCount(arrival.id)).toBe(1);
  });
});

describe('a Paused arrival', () => {
  async function pausedThread() {
    const { userId, threadId } = await freshThread();
    await drained(await submit({ userId, threadId, content: 'I love hiking in the Alps' }));
    const shift = await submit({ userId, threadId, content: 'Explain how espresso machines work' });
    if (shift.type !== 'success' || !isDriftPause(shift.data)) {
      throw new Error('the second arrival must pause');
    }
    return { userId, threadId, pausedId: shift.data.threadVerdict.messageId };
  }

  it('reports the pause again on a plain retry', async () => {
    const { userId, threadId, pausedId } = await pausedThread();

    const again = await retry({ userId, threadId });

    expect(again.type === 'success' && isDriftPause(again.data)).toBe(true);
    const rows = await listMessagesByThread({ threadId });
    expect(rows.at(-1)?.id).toBe(pausedId);
  });

  it('replies when the user chooses to continue, replaying the stored fire', async () => {
    const { userId, threadId, pausedId } = await pausedThread();

    const reply = await drained(await retry({ userId, threadId }, 'continue'));

    expect(reply.threadVerdict).toMatchObject({ messageId: pausedId, verdict: 'fire' });
    expect(await verdictCount(pausedId)).toBe(1);
  });
});
