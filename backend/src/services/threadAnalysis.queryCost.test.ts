import { db, requestDbScope } from '@db/db';
import { insertMessage } from '@queries/messages/insertMessage';
import { listSegmentDriftLogsByThread } from '@queries/segmentDriftLogs/listSegmentDriftLogsByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { runLiveGate } from '@services/threadAnalysis';
import { DEFAULT_USER_ID } from '@services/userService';
import { useTestDb } from '@test/test-db';
import type { KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';

/**
 * What judging one arrival costs the database. A live Thread grows one
 * Turn at a time: each arrival is judged before its reply lands, so the
 * next judgment also folds the previous Turn. That judgment must cost the
 * same number of queries however long the Thread already is.
 */

// Long enough that the gate never asks for a rewrite: no rewrite or judge
// calls, so the count holds only the gate's own reads and writes.
const PAD =
  ' consider every practical detail carefully before you answer this, accounting for common edge' +
  ' cases, and explain your reasoning step by step so a beginner can follow along clearly';

useTestDb();

let mock: MockInferenceServer;
let savedMockUrl: string | undefined;

beforeAll(async () => {
  savedMockUrl = process.env.MOCK_AI_BASE_URL;
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterAll(async () => {
  process.env.MOCK_AI_BASE_URL = savedMockUrl ?? '';
  await mock.stop();
});

/** Runs `fn` and reports how many queries it sent to the database. */
async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; queries: number }> {
  let queries = 0;
  const counting: KyselyPlugin = {
    transformQuery: (args) => args.node,
    transformResult: async (args) => {
      queries += 1;
      return args.result;
    },
  };
  const result = await requestDbScope.run(db.withPlugin(counting), fn);
  return { result, queries };
}

/** Adds an arrival and judges it, the way a live exchange does, before its reply. */
async function arriveAndJudge(threadId: string, index: number): Promise<string> {
  const arrival = await insertMessage({
    threadId,
    role: 'user',
    content: `question ${index} about subject ${index}${PAD}`,
  });
  const judged = await runLiveGate({ threadId, upToMessageId: arrival.id });
  expect(judged.type).toBe('success');
  return arrival.id;
}

async function reply(threadId: string, index: number): Promise<void> {
  await insertMessage({ threadId, role: 'assistant', content: `answer ${index}${PAD}` });
}

/**
 * A Thread of `turns` live Turns, each arrival judged before its reply
 * landed, and the next arrival waiting for its verdict.
 */
async function liveThreadAwaitingVerdict(turns: number) {
  await insertUserIfNotExists({ id: DEFAULT_USER_ID });
  const { id: threadId } = await insertThread({ userId: DEFAULT_USER_ID, title: `${turns}` });
  for (let index = 0; index < turns; index += 1) {
    await arriveAndJudge(threadId, index);
    await reply(threadId, index);
  }
  const arrival = await insertMessage({
    threadId,
    role: 'user',
    content: `question ${turns} about subject ${turns}${PAD}`,
  });
  return { threadId, arrivalId: arrival.id };
}

async function judgmentCost(turns: number): Promise<number> {
  const { threadId, arrivalId } = await liveThreadAwaitingVerdict(turns);
  const { result, queries } = await countQueries(() =>
    runLiveGate({ threadId, upToMessageId: arrivalId }),
  );
  expect(result.type).toBe('success');
  const logs = await listSegmentDriftLogsByThread({ threadId, modelId: EMBEDDING_MODEL_ID });
  expect(logs).toHaveLength(turns + 1);
  return queries;
}

describe('the cost of judging an arrival', () => {
  it('stays the same number of queries however long the Thread is', async () => {
    const short = await judgmentCost(2);
    const long = await judgmentCost(16);
    expect(long).toBe(short);
  });

  it('reads a finished Thread in a fixed handful of queries', async () => {
    const { threadId, arrivalId } = await liveThreadAwaitingVerdict(12);
    expect((await runLiveGate({ threadId, upToMessageId: arrivalId })).type).toBe('success');

    const replayed = await countQueries(() => runLiveGate({ threadId, upToMessageId: arrivalId }));
    expect(replayed.result.type).toBe('success');
    // The Thread, its embeddings, its expansions, its verdicts, its segments.
    expect(replayed.queries).toBe(5);
  });
});
