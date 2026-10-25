import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import { findResumeDraft } from '@queries/messages/findResumeDraft';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { findSegmentDriftLogByMessageId } from '@queries/segmentDriftLogs/findSegmentDriftLogByMessageId';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  enqueueDriftGateJudgeArrival,
  findDriftGateJudgeArrivalJobOrNull,
} from '@queue/tasks/driftGateJudgeArrivalTask';
import { findMemoryCaptureSegmentJobOrNull } from '@queue/tasks/memoryCaptureSegmentTask';
import {
  EMBEDDING_MODEL_ID,
  isDriftPause,
  retryLastExchange,
  submitChat,
} from '@services/aiService';
import { subscribe } from '@services/events';
import { handOverArrival } from '@services/handoverService';
import { assembledSystemPrompt, captureUnreadTurns } from '@services/memory';
import { editMessage } from '@services/messageService';
import { memoryOn } from '@test/memory';
import { makeWaitingJobsDue, useTestQueue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { readUIMessageStream } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';
import type { ChatStreamHandle, RetryChoice } from '../types/aiService';
import type { ServerEvent } from '../types/events';

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
useTestQueue({ memory: memoryOn, threadAnalysisMode: 'heuristic' });

const judging = { enqueueDriftGateJudgeArrival, findDriftGateJudgeArrivalJobOrNull };
/** This suite asserts the move itself, not titles: settlement never asks for one. */
const titling = { enqueueThreadGenerateTitle: async () => {} };

function submit(props: { userId: string; threadId: string; content: string }) {
  return submitChat({
    ...props,
    judging,
    titling,
    memory: memoryOn,
    threadAnalysisMode: 'heuristic',
  });
}

function retryExchange(props: { userId: string; threadId: string }, choice: RetryChoice = 'retry') {
  return retryLastExchange({
    ...props,
    choice,
    judging,
    titling,
    memory: memoryOn,
    threadAnalysisMode: 'heuristic',
  });
}

/** A short hold, so a handover waiting on a failing capture answers quickly. */
const SHORT_HANDOVER_WAIT_MS = '300';
const savedHandoverWait = process.env.HANDOVER_WAIT_MS;

afterEach(() => {
  mock.memory.clearFailures();
  process.env.HANDOVER_WAIT_MS = savedHandoverWait ?? '';
});

/** The segment the arrival's fire closed. */
async function closedSegmentIdOf(messageId: string) {
  const logged = await findSegmentDriftLogByMessageId({ messageId, modelId: EMBEDDING_MODEL_ID });
  if (!logged) throw new Error('the arrival closed no segment');
  return logged.segmentId;
}

/**
 * Asks for the handover the way the browser does: again whenever the
 * capture is still pending, with its retry pauses brought forward.
 */
async function handOverOnceSettled(props: {
  userId: string;
  threadId: string;
  messageId: string;
}) {
  for (let tries = 0; tries < 40; tries += 1) {
    const result = await handOverArrival({ ...props, memory: memoryOn });
    if (result.type === 'success' || result.code !== 'capture_pending') return result;
    await makeWaitingJobsDue();
  }
  throw new Error('the capture never settled');
}

async function drain(handle: ChatStreamHandle) {
  for await (const _message of readUIMessageStream({ stream: handle.stream })) {
    // Consuming the stream lets the exchange settle.
  }
  await handle.outcome;
}

/**
 * A thread with one settled Turn and a second arrival paused on a fire.
 * `beforeShift` runs just before the second arrival, while the first
 * segment is still open, so nothing about its capture has started yet.
 */
async function pausedThread(beforeShift: () => void = () => {}) {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Pause thread' });
  const threadId = thread.id;

  const opening = await submit({ userId, threadId, content: 'I love hiking in the Alps' });
  if (opening.type !== 'success' || isDriftPause(opening.data)) {
    throw new Error('the opening arrival must exchange');
  }
  await drain(opening.data);

  beforeShift();
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
    const segmentId = await closedSegmentIdOf(pausedMessageId);
    const heard: ServerEvent[] = [];
    const subscription = subscribe(userId, (event) => {
      if (event.kind === 'memory-captured' && event.threadId === threadId) heard.push(event);
    });

    const result = await handOverArrival({
      userId,
      threadId,
      messageId: pausedMessageId,
      memory: memoryOn,
    });
    subscription.close();
    if (result.type !== 'success') throw new Error(`handover failed: ${result.code}`);

    // The move waited on the queued capture of the closed segment, not on a clock.
    expect(heard).toContainEqual({ kind: 'memory-captured', userId, threadId, segmentId });
    const freshThreadId = result.data.thread.id;
    expect(result.data.message).toMatchObject({
      threadId: freshThreadId,
      role: 'user',
      content: 'Explain how espresso machines work',
    });
    const oldRows = await listMessagesByThread({ threadId });
    expect(oldRows.find((row) => row.id === pausedMessageId)?.abandoned).toBe(true);

    const seed = await db
      .selectFrom('memory.threadSeeds')
      .selectAll()
      .where('threadId', '=', result.data.thread.id)
      .executeTakeFirstOrThrow();
    expect(seed.handoverMessageId).toBe(pausedMessageId);
    const prompt = await assembledSystemPrompt({
      userId,
      threadId: result.data.thread.id,
      basePrompt: 'Base.',
      memory: memoryOn,
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

  it('holds the move while the capture is still trying, then moves with its Facts', async () => {
    process.env.HANDOVER_WAIT_MS = SHORT_HANDOVER_WAIT_MS;
    const { userId, threadId, pausedMessageId } = await pausedThread(() =>
      mock.memory.failExtractions(),
    );

    const held = await handOverArrival({
      userId,
      threadId,
      messageId: pausedMessageId,
      memory: memoryOn,
    });

    expect(held).toMatchObject({ type: 'error', code: 'capture_pending' });
    const rows = await listMessagesByThread({ threadId });
    expect(rows.find((row) => row.id === pausedMessageId)?.abandoned).toBe(false);

    mock.memory.clearFailures();
    const moved = await handOverOnceSettled({ userId, threadId, messageId: pausedMessageId });
    if (moved.type !== 'success') throw new Error(`handover failed: ${moved.code}`);
    const prompt = await assembledSystemPrompt({
      userId,
      threadId: moved.data.thread.id,
      basePrompt: 'Base.',
      memory: memoryOn,
    });
    expect(prompt).toContain('The user loves hiking in the Alps.');
  });

  it('moves without the closed segment once its capture gives up', async () => {
    process.env.HANDOVER_WAIT_MS = SHORT_HANDOVER_WAIT_MS;
    const { userId, threadId, pausedMessageId } = await pausedThread(() =>
      mock.memory.failExtractions(),
    );

    const result = await handOverOnceSettled({ userId, threadId, messageId: pausedMessageId });

    if (result.type !== 'success') throw new Error(`handover failed: ${result.code}`);
    expect(
      await findMemoryCaptureSegmentJobOrNull(await closedSegmentIdOf(pausedMessageId)),
    ).toMatchObject({ state: 'dead' });
    const prompt = await assembledSystemPrompt({
      userId,
      threadId: result.data.thread.id,
      basePrompt: 'Base.',
      memory: memoryOn,
    });
    expect(prompt).toBe('Base.');
  });

  it('lets only one of two simultaneous handovers move the arrival', async () => {
    const { userId, threadId, pausedMessageId } = await pausedThread();

    const results = await Promise.all([
      handOverArrival({ userId, threadId, messageId: pausedMessageId, memory: memoryOn }),
      handOverArrival({ userId, threadId, messageId: pausedMessageId, memory: memoryOn }),
    ]);

    expect(results.map((result) => result.type).sort()).toEqual(['error', 'success']);
    const seeds = await db
      .selectFrom('memory.threadSeeds')
      .select('threadId')
      .where('handoverMessageId', '=', pausedMessageId)
      .execute();
    expect(seeds).toHaveLength(1);
  });

  it('retries the last live turn without reviving the handed-over arrival or offering it as a draft', async () => {
    const { userId, threadId, pausedMessageId } = await pausedThread();
    await handOverArrival({ userId, threadId, messageId: pausedMessageId, memory: memoryOn });

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
    await handOverArrival({ userId, threadId, messageId: pausedMessageId, memory: memoryOn });
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

  it('leaves the segment of a capture that gave up owed, for a later pass to read', async () => {
    process.env.HANDOVER_WAIT_MS = SHORT_HANDOVER_WAIT_MS;
    const { userId, threadId, pausedMessageId } = await pausedThread(() =>
      mock.memory.failExtractions(),
    );
    await handOverOnceSettled({ userId, threadId, messageId: pausedMessageId });
    mock.memory.clearFailures();

    await captureUnreadTurns({ userId, threadId });

    const facts = await db
      .selectFrom('memory.userFacts')
      .select('content')
      .where('userId', '=', userId)
      .execute();
    expect(facts.map((fact) => fact.content)).toContain('The user loves hiking in the Alps.');
  });

  it('refuses a message that is not a paused arrival', async () => {
    const { userId, threadId } = await pausedThread();
    const opening = (await listMessagesByThread({ threadId })).find((row) => row.role === 'user');
    if (!opening) throw new Error('opening row');

    const result = await handOverArrival({
      userId,
      threadId,
      messageId: opening.id,
      memory: memoryOn,
    });

    expect(result).toMatchObject({ type: 'error', code: 'arrival_not_paused' });
  });
});
