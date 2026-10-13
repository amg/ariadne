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
import { publish } from '@services/events';
import { editMessage } from '@services/messageService';
import { someoneWaitsOnALock, useHeldTransactions } from '@test/locks';
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

function retry(
  props: { userId: string; threadId: string },
  choice: RetryChoice = 'retry',
  signal?: AbortSignal,
) {
  return retryLastExchange({
    ...props,
    choice,
    judging,
    titling,
    memory: memoryOn,
    ...(signal ? { signal } : {}),
  });
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
    .select('messageId')
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

  it('starts no reply when the client is gone by the time the verdict answers', async () => {
    const { userId, threadId } = await freshThread();
    process.env.GATE_WAIT_MS = '0';
    await submit({ userId, threadId, content: 'Judged while nobody waited' });
    const arrival = await newestUserRow(threadId);
    await judgmentSettled(arrival.id);
    const gone = new AbortController();
    gone.abort();

    const result = await retry({ userId, threadId }, 'retry', gone.signal);

    expect(result).toMatchObject({ type: 'error', code: 'client_gone' });
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

describe('requests meeting on one arrival', () => {
  /**
   * Judging that queues nothing, so a request waits on a judgment that
   * runs only once the test queues it for real. `asked` resolves once the
   * request has asked for one, its verdict listener open by then.
   */
  function heldJudging() {
    let calls = 0;
    return {
      judging: {
        enqueueDriftGateJudgeArrival: async () => {
          calls += 1;
        },
        findDriftGateJudgeArrivalJobOrNull,
      },
      asked: async () => {
        const deadline = Date.now() + 5000;
        while (calls === 0) {
          if (Date.now() > deadline) throw new Error('no judgment was asked for');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    };
  }

  /** The submitted arrival, once its transaction has committed. */
  async function storedArrival(threadId: string) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const rows = await listMessagesByThread({ threadId });
      const row = rows.find((r) => r.role === 'user' && !r.abandoned);
      if (row) return row;
      if (Date.now() > deadline) throw new Error('the arrival was never stored');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const openTransaction = useHeldTransactions();

  function heldSubmit(props: { userId: string; threadId: string; content: string }) {
    const held = heldJudging();
    return submitChat({ ...props, judging: held.judging, titling, memory: memoryOn });
  }

  it('starts one reply when a submit and a retry wake on the same verdict', async () => {
    const { userId, threadId } = await freshThread();
    process.env.GATE_WAIT_MS = '10000';
    const submitted = heldSubmit({ userId, threadId, content: 'Two tabs, one question' });
    const arrival = await storedArrival(threadId);
    const retryHeld = heldJudging();
    const retried = retryLastExchange({
      userId,
      threadId,
      choice: 'retry',
      judging: retryHeld.judging,
      titling,
      memory: memoryOn,
    });
    await retryHeld.asked();

    await enqueueDriftGateJudgeArrival({ userId, threadId, messageId: arrival.id });
    const results = await Promise.all([submitted, retried]);

    const started = results.filter((result) => result.type === 'success');
    expect(started).toHaveLength(1);
    expect(results.find((result) => result.type === 'error')).toMatchObject({
      code: 'arrival_answered',
    });
    await drained(started[0] ?? results[0]);
    const rows = await listMessagesByThread({ threadId });
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant']);
  });

  it('starts no reply for an arrival edited away during the wait', async () => {
    const { userId, threadId } = await freshThread();
    process.env.GATE_WAIT_MS = '10000';
    const submitted = heldSubmit({ userId, threadId, content: 'Before the edit' });
    const arrival = await storedArrival(threadId);
    const edit = await editMessage({
      userId,
      threadId,
      messageId: arrival.id,
      content: 'After the edit',
      judging: heldJudging().judging,
    });
    expect(edit.type).toBe('success');

    // A judgment already past its liveness check when the edit landed
    // still announces its verdict.
    publish({ kind: 'verdict-ok', userId, threadId, messageId: arrival.id, verdict: 'pass' });

    expect(await submitted).toMatchObject({ type: 'error', code: 'arrival_abandoned' });
    const rows = await listMessagesByThread({ threadId });
    expect(rows.map((row) => [row.role, row.content, row.abandoned])).toEqual([
      ['user', 'Before the edit', true],
      ['user', 'After the edit', false],
    ]);
  });

  it('starts one fresh reply when two retries regenerate an answered arrival', async () => {
    const { userId, threadId } = await freshThread();
    const first = await drained(await submit({ userId, threadId, content: 'Answer me twice' }));

    const results = await Promise.all([retry({ userId, threadId }), retry({ userId, threadId })]);

    const started = results.filter((result) => result.type === 'success');
    expect(started).toHaveLength(1);
    expect(results.find((result) => result.type === 'error')).toMatchObject({
      code: 'exchange_in_flight',
    });
    const fresh = await drained(started[0] ?? results[0]);
    const rows = await listMessagesByThread({ threadId });
    expect(rows.map((row) => [row.id, row.abandoned])).toEqual([
      [rows[0]?.id, false],
      [first.assistantMessageId, true],
      [fresh.assistantMessageId, false],
    ]);
  });

  it('starts no reply when an edit commits while the reply waits on the arrival', async () => {
    const { userId, threadId } = await freshThread();
    process.env.GATE_WAIT_MS = '10000';
    const submitted = heldSubmit({ userId, threadId, content: 'Before the edit' });
    const arrival = await storedArrival(threadId);
    const edit = await openTransaction();
    await edit.trx
      .updateTable('chat.messages')
      .set({ abandoned: true })
      .where('id', '=', arrival.id)
      .execute();

    publish({ kind: 'verdict-ok', userId, threadId, messageId: arrival.id, verdict: 'pass' });
    await someoneWaitsOnALock();
    await insertMessage({ threadId, role: 'user', content: 'After the edit' }, edit.trx);
    await edit.commit();

    expect(await submitted).toMatchObject({ type: 'error', code: 'arrival_abandoned' });
    const rows = await listMessagesByThread({ threadId });
    expect(rows.map((row) => row.role)).toEqual(['user', 'user']);
  });

  it('abandons a reply that started while the edit waited on the arrival', async () => {
    const { userId, threadId } = await freshThread();
    const arrival = await insertMessage({ threadId, role: 'user', content: 'Before the edit' });
    const claim = await openTransaction();
    await claim.trx
      .selectFrom('chat.messages')
      .select('id')
      .where('id', '=', arrival.id)
      .forUpdate()
      .execute();
    const reply = await insertMessage(
      { threadId, role: 'assistant', content: '', exchangeStatus: 'pending' },
      claim.trx,
    );

    const edited = editMessage({
      userId,
      threadId,
      messageId: arrival.id,
      content: 'After the edit',
      judging: heldJudging().judging,
    });
    await someoneWaitsOnALock();
    await claim.commit();

    expect((await edited).type).toBe('success');
    const rows = await listMessagesByThread({ threadId });
    expect(rows.map((row) => [row.id === reply.id, row.abandoned])).toEqual([
      [false, true],
      [true, true],
      [false, false],
    ]);
  });
});
