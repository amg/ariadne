import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import { insertMessage } from '@queries/messages/insertMessage';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { listSegmentDriftLogsByThread } from '@queries/segmentDriftLogs/listSegmentDriftLogsByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { TaskFailure, classifyTaskError } from '@queue/errors';
import {
  enqueueDriftGateFoldTurn,
  findDriftGateFoldTurnJobOrNull,
  foldTurn,
} from '@queue/tasks/driftGateFoldTurnTask';
import { queueTasks } from '@queue/worker';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { runLiveGate } from '@services/threadAnalysis';
import { memoryOff } from '@test/memory';
import { drainQueue } from '@test/queue';
import { sideCostsOfThread } from '@test/sideCosts';
import { useStoppableWrites } from '@test/stoppedWrites';
import { useTestDb } from '@test/test-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type MockInferenceServer,
  buildMockEmbedding,
  startMockInferenceServer,
} from '../../mock/inferenceServer';

/**
 * The queue's fold of one completed Turn. Judgments run before their
 * Turn's reply lands, so the newest Turn's fold is always queue work —
 * this task is what keeps the checkpoint current between arrivals. The
 * live shape it serves: arrive, judge, reply, fold.
 */

// Long enough that the gate never asks for a rewrite.
const PAD =
  ' consider every practical detail carefully before you answer this, accounting for common edge' +
  ' cases, and explain your reasoning step by step so a beginner can follow along clearly';

/** pgvector stores float4 — simulate the round-trip like the rows do. */
function toFloat4(vector: number[]) {
  return vector.map((value) => Math.fround(value));
}

function prospectiveText(user: string) {
  return `User:\n${user}\n\n`;
}

function turnBlock(user: string, assistant: string) {
  return `User:\n${user}\n\nAssistant:\n${assistant}\n\n`;
}

function cosineDistance(a: number[], b: number[]) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1;
  return Math.min(2, Math.max(0, 1 - dot / denom));
}

function unitVector(vector: number[]) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

let mock: MockInferenceServer;

beforeAll(async () => {
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterAll(async () => {
  await mock.stop();
});

useTestDb();
const stopWritesTo = useStoppableWrites();

/**
 * One live exchange: the arrival judged before its reply lands, the way
 * the chat route drives the gate — the reply's Turn folds only after it
 * completes, which is this task's job.
 */
async function exchange(threadId: string, user: string, assistant: string) {
  const arrival = await insertMessage({ threadId, role: 'user', content: `${user}${PAD}` });
  const judged = await runLiveGate({ threadId, upToMessageId: arrival.id, mode: 'heuristic' });
  expect(judged.type).toBe('success');
  const reply = await insertMessage({ threadId, role: 'assistant', content: `${assistant}${PAD}` });
  return { arrivalId: arrival.id, replyId: reply.id };
}

/** The thread's stored folds by the Turn they completed. */
async function foldsOf(threadId: string) {
  return db
    .selectFrom('analysis.turnFolds as f')
    .innerJoin('chat.messages as m', 'm.id', 'f.messageId')
    .where('m.threadId', '=', threadId)
    .orderBy('f.completedTurns asc')
    .select(['f.messageId', 'f.completedTurns', 'f.anchorCount'])
    .execute();
}

/** The thread's stored folds, with the sums a later judgment reads. */
async function foldValuesOf(threadId: string) {
  return db
    .selectFrom('analysis.turnFolds as f')
    .innerJoin('chat.messages as m', 'm.id', 'f.messageId')
    .where('m.threadId', '=', threadId)
    .orderBy('f.completedTurns asc')
    .select(['f.completedTurns', 'f.anchorCount', 'f.gravitySum', 'f.anchorSum'])
    .execute();
}

/** A thread of two exchanges, the second Turn's fold still owed to the queue. */
async function threadOwingItsNewestFold() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId });
  await exchange(threadId, 'How do sourdough starters stay healthy', 'Feed and hydrate them');
  const second = await exchange(
    threadId,
    'How do jet turbines compress air',
    'Through axial stages',
  );
  return { threadId, turn: { threadId, messageId: second.replyId } };
}

describe('foldTurn', () => {
  it('folds the newest completed Turn, whose judgment passed it by', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId });
    const first = await exchange(
      threadId,
      'How do sourdough starters stay healthy',
      'Feed and hydrate them',
    );
    const second = await exchange(
      threadId,
      'How do jet turbines compress air',
      'Through axial stages',
    );

    // Judging the second arrival folded the first Turn inline; the second
    // Turn's fold is queue work — its reply landed after its judgment.
    expect((await foldsOf(threadId)).map((fold) => fold.completedTurns)).toEqual([1]);

    await foldTurn({
      turn: { threadId, messageId: second.replyId },
      threadAnalysisMode: 'heuristic',
    });

    expect((await foldsOf(threadId)).map((fold) => fold.completedTurns)).toEqual([1, 2]);
    expect(first.arrivalId).not.toBe(second.arrivalId);
  });

  it('re-seeds on the Turn whose arrival fired, so the next judgment reads the fire', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId });
    await exchange(threadId, 'How do sourdough starters stay healthy', 'Feed and hydrate them');
    const fired = await exchange(
      threadId,
      'How do jet turbines compress air',
      'Through axial stages',
    );
    await foldTurn({
      turn: { threadId, messageId: fired.replyId },
      threadAnalysisMode: 'heuristic',
    });

    // The mock embeds distinct texts far apart, so the second arrival
    // fired: the fast-path judgment of the third reads this task's fold,
    // and its reading must be the distance to the re-seeded Turn alone.
    const third = await exchange(threadId, 'How do sailboats stay upright', 'Ballast and trim');
    const logs = await listSegmentDriftLogsByThread({ threadId, modelId: EMBEDDING_MODEL_ID });
    const log = logs.find((row) => row.messageId === third.arrivalId);
    expect(log?.verdict).toBe('fire');
    const expected = cosineDistance(
      toFloat4(buildMockEmbedding(prospectiveText(`How do sailboats stay upright${PAD}`))),
      unitVector(
        toFloat4(
          buildMockEmbedding(
            turnBlock(`How do jet turbines compress air${PAD}`, `Through axial stages${PAD}`),
          ),
        ),
      ),
    );
    expect(log?.driftP).toBeCloseTo(expected, 4);
  });

  it('leaves the checkpoint untouched for a Turn the keep-two rule moved past', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId });
    const first = await exchange(
      threadId,
      'How do sourdough starters stay healthy',
      'Feed and hydrate them',
    );
    const second = await exchange(
      threadId,
      'How do jet turbines compress air',
      'Through axial stages',
    );
    await exchange(threadId, 'How do sailboats stay upright', 'Ballast and trim');
    await foldTurn({
      turn: { threadId, messageId: second.replyId },
      threadAnalysisMode: 'heuristic',
    });
    // Turn one's fold left the keep-two window; the task must not
    // resurrect a checkpoint nothing reads.
    await db.deleteFrom('analysis.turnFolds').where('messageId', '=', first.replyId).execute();
    const before = await foldsOf(threadId);

    await foldTurn({
      turn: { threadId, messageId: first.replyId },
      threadAnalysisMode: 'heuristic',
    });

    expect(await foldsOf(threadId)).toEqual(before);
  });

  it('gives up without writing when the reply is not live', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId });
    const turn = await exchange(
      threadId,
      'How do sourdough starters stay healthy',
      'Feed and hydrate them',
    );
    await setMessagesAbandoned({ messageIds: [turn.replyId], abandoned: true });
    const before = await foldsOf(threadId);

    await foldTurn({
      turn: { threadId, messageId: turn.replyId },
      threadAnalysisMode: 'heuristic',
    });
    await foldTurn({
      turn: { threadId, messageId: randomUUID() },
      threadAnalysisMode: 'heuristic',
    });

    expect(await foldsOf(threadId)).toEqual(before);
  });

  it('stores no second fold and pays for no second embedding when run again', async () => {
    const { threadId, turn } = await threadOwingItsNewestFold();
    await foldTurn({ turn, threadAnalysisMode: 'heuristic' });
    const folds = await foldValuesOf(threadId);
    const spend = await sideCostsOfThread(threadId);
    const embeddingCalls = mock.embeddings.requestCount();

    await foldTurn({ turn, threadAnalysisMode: 'heuristic' });

    expect(await foldValuesOf(threadId)).toEqual(folds);
    expect(await sideCostsOfThread(threadId)).toEqual(spend);
    expect(mock.embeddings.requestCount()).toBe(embeddingCalls);
  });

  it('folds to the uninterrupted result when rerun after stopping between its embedding and its fold', async () => {
    const uninterrupted = await threadOwingItsNewestFold();
    await foldTurn({ turn: uninterrupted.turn, threadAnalysisMode: 'heuristic' });

    const { threadId, turn } = await threadOwingItsNewestFold();
    const release = await stopWritesTo('analysis.turn_folds');
    const stopped = await foldTurn({ turn, threadAnalysisMode: 'heuristic' }).catch(
      (error: unknown) => error,
    );
    await release();
    expect(stopped).toBeInstanceOf(Error);
    expect((await foldValuesOf(threadId)).map((fold) => fold.completedTurns)).toEqual([1]);
    const embeddingCalls = mock.embeddings.requestCount();

    await foldTurn({ turn, threadAnalysisMode: 'heuristic' });

    // The reply's embedding stored by the stopped run is reused, not bought again.
    expect(mock.embeddings.requestCount()).toBe(embeddingCalls);
    expect(await foldValuesOf(threadId)).toEqual(await foldValuesOf(uninterrupted.threadId));
    expect(await sideCostsOfThread(threadId)).toEqual(
      await sideCostsOfThread(uninterrupted.threadId),
    );
  });

  it('fails recoverably when the provider does', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId });
    const turn = await exchange(
      threadId,
      'How do sourdough starters stay healthy',
      'Feed and hydrate them',
    );
    mock.embeddings.failFrom(mock.embeddings.requestCount() + 1);
    try {
      const failure = await foldTurn({
        turn: { threadId, messageId: turn.replyId },
        threadAnalysisMode: 'heuristic',
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(TaskFailure);
      expect(classifyTaskError(failure)).toBe('recoverable');
    } finally {
      mock.embeddings.clearFailures();
    }
  });
});

describe('driftGateFoldTurn on the worker', () => {
  it('folds the queued Turn once, however often it was queued while waiting', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const { id: threadId } = await insertThread({ userId });
    await exchange(threadId, 'How do sourdough starters stay healthy', 'Feed and hydrate them');
    const second = await exchange(
      threadId,
      'How do jet turbines compress air',
      'Through axial stages',
    );

    await enqueueDriftGateFoldTurn({ threadId, messageId: second.replyId });
    await enqueueDriftGateFoldTurn({ threadId, messageId: second.replyId });
    await drainQueue(queueTasks({ memory: memoryOff, threadAnalysisMode: 'heuristic' }));

    expect((await foldsOf(threadId)).map((fold) => fold.completedTurns)).toEqual([1, 2]);
    expect(await findDriftGateFoldTurnJobOrNull(second.replyId)).toBeNull();
  });
});
