import { listMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/listMessageEmbeddingsByMessageIds';
import { getSideCostByMessageId } from '@queries/messageSideCosts/getSideCostByMessageId';
import { insertMessage } from '@queries/messages/insertMessage';
import { listSegmentDriftLogsByThread } from '@queries/segmentDriftLogs/listSegmentDriftLogsByThread';
import { listThreadSegmentsByThread } from '@queries/threadSegments/listThreadSegmentsByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { runLiveGate } from '@services/threadAnalysis';
import { DEFAULT_USER_ID } from '@services/userService';
import { useTestDb } from '@test/test-db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';

/**
 * Two Drift gate passes over one Thread, interleaved step by step through
 * the mock's held requests. Every provider call of the two passes returns
 * something different (each embedding call its own vector, each rewrite
 * call its own sentence), so a pass that stored or judged anything other
 * than what is stored would show.
 */

const OPENING = 'Tell me about sourdough baking classes in Lisbon';
const OPENING_REPLY = 'Several bakeries there run weekend classes for beginners.';
/** Anaphoric and short, so the gate asks for a rewrite. */
const FOLLOW_UP = 'What about the price of those?';
/** Two rewrites with equal usage, so each call costs the same. */
const REWRITE_A = 'What is the price of sourdough classes in Lisbon?';
const REWRITE_B = 'What is the cost of sourdough classes in Lisbon?';

useTestDb();

let mock: MockInferenceServer;
let savedMockUrl: string | undefined;

beforeAll(async () => {
  savedMockUrl = process.env.MOCK_AI_BASE_URL;
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterEach(() => {
  mock.embeddings.varyByRequest(false);
  mock.rewrites.replySequence([]);
});

afterAll(async () => {
  process.env.MOCK_AI_BASE_URL = savedMockUrl ?? '';
  await mock.stop();
});

/**
 * A Thread whose opening arrival was judged before its reply landed, and a
 * follow-up waiting for its verdict: judging the follow-up first folds
 * the opening Turn, which is how a live Thread grows.
 */
async function threadAwaitingFollowUpVerdict(title: string) {
  await insertUserIfNotExists({ id: DEFAULT_USER_ID });
  const { id: threadId } = await insertThread({ userId: DEFAULT_USER_ID, title });
  const opening = await insertMessage({ threadId, role: 'user', content: OPENING });
  const judged = await runLiveGate({ threadId, upToMessageId: opening.id });
  expect(judged.type).toBe('success');
  const openingReply = await insertMessage({
    threadId,
    role: 'assistant',
    content: OPENING_REPLY,
  });
  const followUp = await insertMessage({ threadId, role: 'user', content: FOLLOW_UP });
  return {
    threadId,
    openingId: opening.id,
    openingReplyId: openingReply.id,
    followUpId: followUp.id,
  };
}

async function followUpSpend(followUpId: string) {
  const [arrival] = await listMessageEmbeddingsByMessageIds({ messageIds: [followUpId] });
  const rewrite = await getSideCostByMessageId({ messageId: followUpId, kind: 'rewrite' });
  return {
    embeddingCostUsd: Number(arrival?.embeddingCostUsd),
    rewriteCostUsd: Number(rewrite?.costUsd),
    rewritePromptTokens: rewrite?.promptTokens ?? null,
  };
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

describe('two Drift gate passes over one Thread', () => {
  it('store one judgment per arrival, computed on the one embedding and rewrite stored', async () => {
    // What a single pass spends on the follow-up, as the yardstick.
    mock.rewrites.replySequence([REWRITE_A]);
    const alone = await threadAwaitingFollowUpVerdict('one pass');
    expect((await runLiveGate({ threadId: alone.threadId })).type).toBe('success');
    const onePass = await followUpSpend(alone.followUpId);

    const { threadId, openingId, openingReplyId, followUpId } =
      await threadAwaitingFollowUpVerdict('two passes');
    mock.embeddings.varyByRequest(true);
    mock.rewrites.replySequence([REWRITE_A, REWRITE_B]);

    // Both passes ask for a rewrite of the follow-up before either stores one.
    const rewriteOfA = mock.rewrites.holdNext();
    const passA = runLiveGate({ threadId });
    await rewriteOfA.arrived;
    const rewriteOfB = mock.rewrites.holdNext();
    const passB = runLiveGate({ threadId, upToMessageId: followUpId });
    await rewriteOfB.arrived;

    // A stores its rewrite and asks for an embedding. B's rewrite comes
    // back second, so B embeds A's rewrite, stores that vector, and
    // judges, while A's embedding call is still out.
    const embedOfA = mock.embeddings.holdNext();
    rewriteOfA.release();
    await embedOfA.arrived;
    rewriteOfB.release();
    const outcomeB = await passB;
    embedOfA.release();
    const outcomeA = await passA;

    expect(outcomeA.type).toBe('success');
    expect(outcomeB.type).toBe('success');
    if (outcomeA.type !== 'success' || outcomeB.type !== 'success') return;
    expect(outcomeA.data).toEqual(outcomeB.data);

    const stored = await listMessageEmbeddingsByMessageIds({
      messageIds: [followUpId, openingReplyId],
    });
    const arrival = stored.find((row) => row.messageId === followUpId);
    const turn = stored.find((row) => row.messageId === openingReplyId);
    expect(arrival?.rewrittenText).toBe(REWRITE_A);
    expect(arrival?.expandOutcome).toBe('accepted');
    if (!arrival?.embedding || !turn?.embedding) throw new Error('expected stored vectors');

    const [segments, logs] = await Promise.all([
      listThreadSegmentsByThread({ threadId, modelId: EMBEDDING_MODEL_ID }),
      listSegmentDriftLogsByThread({ threadId, modelId: EMBEDDING_MODEL_ID }),
    ]);
    expect(logs.map((log) => log.messageId)).toEqual([openingId, followUpId]);
    const verdict = logs[1];
    if (!verdict?.driftP) throw new Error('expected a judged follow-up');
    // The verdict was reached on the stored vectors: the follow-up's
    // embedding against the opening Turn's, the segment's only member.
    expect(verdict.driftP).toBeCloseTo(cosineDistance(arrival.embedding, turn.embedding), 5);
    expect(verdict.verdict).toBe('fire');
    expect(segments.map((segment) => segment.startMessageId)).toEqual([openingId, followUpId]);
    expect(verdict.segmentStartMessageId).toBe(openingId);

    // Both passes paid for a rewrite and an embedding of the follow-up.
    const twoPasses = await followUpSpend(followUpId);
    expect(twoPasses.rewriteCostUsd).toBeCloseTo(2 * onePass.rewriteCostUsd, 10);
    expect(twoPasses.rewritePromptTokens).toBe(2 * (onePass.rewritePromptTokens ?? 0));
    expect(twoPasses.embeddingCostUsd).toBeCloseTo(2 * onePass.embeddingCostUsd, 10);
  });
});
