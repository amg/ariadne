import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import { findResumeDraft } from '@queries/messages/findResumeDraft';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
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
import { handOverArrival } from '@services/handoverService';
import { assembledSystemPrompt, captureClosedSegments } from '@services/memory';
import { editMessage } from '@services/messageService';
import { useTestQueue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { readUIMessageStream } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';

/**
 * The pause-and-choose flow end to end against the mock provider. The mock
 * embeds every distinct text far apart, so the second arrival of a thread
 * always fires the gate — which is exactly the pause this suite drives.
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
useTestQueue();

const judging = { enqueueDriftGateJudgeArrival, findDriftGateJudgeArrivalJobOrNull };
/** This suite asserts the move itself, not titles: settlement never asks for one. */
const titling = { enqueueThreadGenerateTitle: async () => {} };

function submit(props: { userId: string; threadId: string; content: string }) {
  return submitChat({ ...props, judging, titling });
}

function retryExchange(props: { userId: string; threadId: string }, choice: RetryChoice = 'retry') {
  return retryLastExchange({ ...props, choice, judging, titling });
}

async function drain(handle: ChatStreamHandle): Promise<void> {
  for await (const _message of readUIMessageStream({ stream: handle.stream })) {
    // Consuming the stream lets the exchange settle.
  }
  await handle.outcome;
}

/** A thread with one settled Turn and a second arrival paused on a fire. */
async function pausedThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Pause thread' });
  const threadId = thread.id;

  const opening = await submit({ userId, threadId, content: 'I love hiking in the Alps' });
  if (opening.type !== 'success' || isDriftPause(opening.data)) {
    throw new Error('the opening arrival must exchange');
  }
  await drain(opening.data);

  const shift = await submit({
    userId,
    threadId,
    content: 'Explain how espresso machines work',
  });
  if (shift.type !== 'success' || !isDriftPause(shift.data)) {
    throw new Error('the second arrival must pause');
  }
  return { userId, threadId, pausedMessageId: shift.data.threadVerdict.messageId };
}

describe('drift pause', () => {
  it('stores the fired arrival without starting an exchange', async () => {
    const { threadId, pausedMessageId } = await pausedThread();

    const rows = await listMessagesByThread({ threadId });
    expect(rows.at(-1)?.id).toBe(pausedMessageId);
    expect(rows.filter((row) => row.role === 'assistant')).toHaveLength(1);
  });

  it('refuses a further submit until the user chooses', async () => {
    const { userId, threadId } = await pausedThread();

    const next = await submit({ userId, threadId, content: 'hello again' });

    expect(next).toMatchObject({ type: 'error', code: 'arrival_paused' });
  });

  it('continues in the same thread through a retry', async () => {
    const { userId, threadId, pausedMessageId } = await pausedThread();

    const continued = await retryExchange({ userId, threadId }, 'continue');
    if (continued.type !== 'success' || isDriftPause(continued.data)) {
      throw new Error('the retry must exchange');
    }
    await drain(continued.data);

    const rows = await listMessagesByThread({ threadId });
    expect(rows.at(-2)?.id).toBe(pausedMessageId);
    expect(rows.at(-1)?.role).toBe('assistant');
    expect(rows.at(-1)?.exchangeStatus).toBe('completed');
  });
});

describe('edit into a new topic', () => {
  it('pauses the fork on its first judgment instead of exchanging', async () => {
    const { userId, threadId, pausedMessageId } = await pausedThread();
    const continued = await retryExchange({ userId, threadId }, 'continue');
    if (continued.type !== 'success' || isDriftPause(continued.data)) {
      throw new Error('the retry must exchange');
    }
    await drain(continued.data);

    const fork = await editMessage({
      judging,
      userId,
      threadId,
      messageId: pausedMessageId,
      content: 'Tell me about volcanoes in Iceland',
    });
    if (fork.type !== 'success') throw new Error('the edit must fork');
    const retried = await retryExchange({ userId, threadId });

    expect(retried.type === 'success' && isDriftPause(retried.data)).toBe(true);
    const rows = await listMessagesByThread({ threadId });
    expect(rows.filter((row) => !row.abandoned).at(-1)?.content).toBe(
      'Tell me about volcanoes in Iceland',
    );
  });
});

describe('handOverArrival', () => {
  it('moves the paused arrival to a fresh Thread seeded with the closed segment', async () => {
    const { userId, threadId, pausedMessageId } = await pausedThread();

    const result = await handOverArrival({ userId, threadId, messageId: pausedMessageId });
    if (result.type !== 'success') throw new Error(`handover failed: ${result.code}`);

    const freshThreadId = result.data.thread.id;
    expect(result.data.message).toMatchObject({
      threadId: freshThreadId,
      role: 'user',
      content: 'Explain how espresso machines work',
    });
    const oldRows = await listMessagesByThread({ threadId });
    expect(oldRows.find((row) => row.id === pausedMessageId)?.abandoned).toBe(true);

    const seed = await db
      .selectFrom('threadSeeds')
      .selectAll()
      .where('threadId', '=', result.data.thread.id)
      .executeTakeFirstOrThrow();
    expect(seed.handoverMessageId).toBe(pausedMessageId);
    const prompt = await assembledSystemPrompt({
      userId,
      threadId: result.data.thread.id,
      basePrompt: 'Base.',
    });
    expect(prompt).toContain('The user loves hiking in the Alps.');

    // The stored first message gets its reply through a retry.
    const reply = await retryExchange({ userId, threadId: freshThreadId });
    if (reply.type !== 'success' || isDriftPause(reply.data)) {
      throw new Error('the fresh thread must exchange');
    }
    await drain(reply.data);
    const freshRows = await listMessagesByThread({ threadId: freshThreadId });
    expect(freshRows.map((row) => [row.role, row.exchangeStatus])).toEqual([
      ['user', 'completed'],
      ['assistant', 'completed'],
    ]);

    // The old thread is free again: its newest live row is a settled reply.
    const next = await submit({ userId, threadId, content: 'Back to hiking boots' });
    expect(next.type).toBe('success');
  });

  it('moves the arrival even when the closed segment fails to capture', async () => {
    const { userId, threadId, pausedMessageId } = await pausedThread();
    mock.memory.failExtractions();

    const result = await handOverArrival({ userId, threadId, messageId: pausedMessageId });
    mock.memory.clearFailures();

    if (result.type !== 'success') throw new Error(`handover failed: ${result.code}`);
    const prompt = await assembledSystemPrompt({
      userId,
      threadId: result.data.thread.id,
      basePrompt: 'Base.',
    });
    expect(prompt).toBe('Base.');
  });

  it('lets only one of two simultaneous handovers move the arrival', async () => {
    const { userId, threadId, pausedMessageId } = await pausedThread();

    const results = await Promise.all([
      handOverArrival({ userId, threadId, messageId: pausedMessageId }),
      handOverArrival({ userId, threadId, messageId: pausedMessageId }),
    ]);

    expect(results.map((result) => result.type).sort()).toEqual(['error', 'success']);
    const seeds = await db
      .selectFrom('threadSeeds')
      .select('threadId')
      .where('handoverMessageId', '=', pausedMessageId)
      .execute();
    expect(seeds).toHaveLength(1);
  });

  it('retries the last live turn without reviving the handed-over arrival or offering it as a draft', async () => {
    const { userId, threadId, pausedMessageId } = await pausedThread();
    await handOverArrival({ userId, threadId, messageId: pausedMessageId });

    const retried = await retryExchange({ userId, threadId });
    if (retried.type !== 'success' || isDriftPause(retried.data)) {
      throw new Error('the last live turn must exchange');
    }
    await drain(retried.data);

    expect(await findResumeDraft({ threadId })).toBeUndefined();
    const oldRows = await listMessagesByThread({ threadId });
    expect(oldRows.find((row) => row.id === pausedMessageId)?.abandoned).toBe(true);
    expect(oldRows.filter((row) => !row.abandoned).map((row) => row.content)).toEqual([
      'I love hiking in the Alps',
      expect.any(String),
    ]);
  });

  it('still lets the old thread edit its last live prompt and exchange the fork', async () => {
    const { userId, threadId, pausedMessageId } = await pausedThread();
    await handOverArrival({ userId, threadId, messageId: pausedMessageId });
    const opening = (await listMessagesByThread({ threadId })).find(
      (row) => row.role === 'user' && !row.abandoned,
    );
    if (!opening) throw new Error('the opening prompt must stay live');

    const fork = await editMessage({
      judging,
      userId,
      threadId,
      messageId: opening.id,
      content: 'I love hiking in the Alps.',
    });
    expect(fork).toMatchObject({
      type: 'success',
      data: { content: 'I love hiking in the Alps.' },
    });

    const retried = await retryExchange({ userId, threadId });
    if (retried.type !== 'success' || isDriftPause(retried.data)) {
      throw new Error('the fork must exchange');
    }
    await drain(retried.data);
    const rows = await listMessagesByThread({ threadId });
    expect(rows.find((row) => row.id === pausedMessageId)?.abandoned).toBe(true);
    expect(rows.filter((row) => !row.abandoned).map((row) => row.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('LOOP-dob7: captures the closed segment later when the handover capture failed', async () => {
    const { userId, threadId, pausedMessageId } = await pausedThread();
    mock.memory.failExtractions();
    await handOverArrival({ userId, threadId, messageId: pausedMessageId });
    mock.memory.clearFailures();

    await captureClosedSegments({ userId, threadId });

    const facts = await db
      .selectFrom('userFacts')
      .select('content')
      .where('userId', '=', userId)
      .execute();
    expect(facts.map((fact) => fact.content)).toContain('The user loves hiking in the Alps.');
  });

  it('refuses a message that is not a paused arrival', async () => {
    const { userId, threadId } = await pausedThread();
    const opening = (await listMessagesByThread({ threadId })).find((row) => row.role === 'user');
    if (!opening) throw new Error('opening row');

    const result = await handOverArrival({ userId, threadId, messageId: opening.id });

    expect(result).toMatchObject({ type: 'error', code: 'arrival_not_paused' });
  });
});
