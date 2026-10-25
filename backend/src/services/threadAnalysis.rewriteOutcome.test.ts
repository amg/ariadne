import { env } from '@config/env';
import { listMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/listMessageEmbeddingsByMessageIds';
import { listMessageExpansionsByMessageIds } from '@queries/messageExpansions/listMessageExpansionsByMessageIds';
import { getSideCostByMessageId } from '@queries/messageSideCosts/getSideCostByMessageId';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { buildLiveAnalysisView, runLiveGate } from '@services/threadAnalysis';
import { DEFAULT_USER_ID } from '@services/userService';
import { useTestDb } from '@test/test-db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type MockInferenceServer,
  buildMockEmbedding,
  startMockInferenceServer,
} from '../../mock/inferenceServer';
import { formattedProspectiveTurn } from './threadAnalysis/turns';

/**
 * E2e coverage of the live lane's rewrite step — the one outcome the
 * mirror walk never exercises, because its corpus stays past the 120-char
 * trigger. Here the arrival is a short anaphoric follow-up, so the
 * heuristic sends it through the bounded rewrite loop: what lands (and why
 * it landed) rides the arrival's expansion row, and the embedded
 * vector proves which reading — rewritten or raw — the gate actually used.
 *
 * Counts ride `requestCount` deltas, never absolutes: the mock server is
 * shared across the whole file. Vector comparisons ride cosine similarity,
 * not byte equality, because the stored float4 round-trip loses digits the
 * deterministic rebuild has.
 */

const USER_ID = DEFAULT_USER_ID;

// Turn 1: long and self-contained — raw fast path, and the prior exchange
// the anaphoric arrival resolves against.
const FIRST_CONTENT =
  'please explain how to keep a sourdough starter healthy, covering feeding schedule, hydration, and temperature so a beginner can follow along step by step';
const FIRST_REPLY = 'Feed it every twelve hours and keep it warm.';

// Turn 2: short anaphoric follow-up — the anaphora heuristic rewrites it.
const RAW_ARRIVAL = 'so what about one made of rice flour?';

// A usable self-contained rewrite (distinct from the raw text, no
// decorations) and the canonical boilerplate refusal the detector seeds on.
const REWRITE = 'What about a sourdough starter made with rice flour?';
const REFUSAL = "I can't assist with this request so I cannot provide that information.";

/** The deterministic mock embed of a Prospective reading. */
function readingVector(reading: string) {
  return buildMockEmbedding(formattedProspectiveTurn(reading));
}

/** Cosine similarity of two unit vectors; -1 when the stored one is absent. */
function cosineSimilarity(stored: number[] | null, expected: number[]) {
  if (stored === null) return -1;
  let dot = 0;
  for (let i = 0; i < expected.length; i += 1) {
    dot += (stored[i] ?? 0) * (expected[i] ?? 0);
  }
  return dot;
}

async function seedRewriteThread() {
  await insertUserIfNotExists({ id: USER_ID });
  const thread = await insertThread({ userId: USER_ID, title: 'refusal echo' });
  await insertMessage({ threadId: thread.id, role: 'user', content: FIRST_CONTENT });
  await insertMessage({ threadId: thread.id, role: 'assistant', content: FIRST_REPLY });
  const arrival = await insertMessage({ threadId: thread.id, role: 'user', content: RAW_ARRIVAL });
  return { threadId: thread.id, arrivalId: arrival.id };
}

/** The arrival's stored state: its expansion row merged with its vector. */
async function readArrivalRow(arrivalId: string) {
  const [embeddings, expansions] = await Promise.all([
    listMessageEmbeddingsByMessageIds({ messageIds: [arrivalId], modelId: EMBEDDING_MODEL_ID }),
    listMessageExpansionsByMessageIds({ messageIds: [arrivalId] }),
  ]);
  const embedding = embeddings[0];
  const expansion = expansions[0];
  if (!embedding || !expansion) throw new Error(`arrival row missing for ${arrivalId}`);
  return { ...expansion, embedding: embedding.embedding };
}

useTestDb();

let mock: MockInferenceServer;
let savedMockUrl: string | undefined;
let savedApiKey: string | undefined;

beforeAll(async () => {
  savedMockUrl = process.env.MOCK_AI_BASE_URL;
  savedApiKey = process.env.DEEPINFRA_API_KEY;
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterEach(() => {
  mock.rewrites.clearFailures();
  mock.rewrites.forceReply(null);
  mock.rewrites.replySequence([]);
});

afterAll(async () => {
  process.env.MOCK_AI_BASE_URL = savedMockUrl ?? '';
  process.env.DEEPINFRA_API_KEY = savedApiKey ?? '';
  await mock.stop();
});

function assertGateOk(result: Awaited<ReturnType<typeof runLiveGate>>) {
  expect(result.type).toBe('success');
}

describe('runLiveGate — the rewrite step records its outcomes', () => {
  it('accepts a landed rewrite: the reading and its vector ride the rewrite', async () => {
    mock.rewrites.forceReply(REWRITE);
    const { threadId, arrivalId } = await seedRewriteThread();
    const rewritesBefore = mock.rewrites.requestCount();
    const embeddingsBefore = mock.embeddings.requestCount();

    assertGateOk(await runLiveGate({ threadId, mode: 'heuristic' }));

    const row = await readArrivalRow(arrivalId);
    expect(row.expandOutcome).toBe('accepted');
    expect(row.expandedText).toBe(REWRITE);
    // The rewrite step's spend lands in the side-cost rows.
    const rewriteSpend = await getSideCostByMessageId({
      messageId: arrivalId,
      kind: 'rewrite',
      model: env.REWRITE_MODEL,
    });
    expect(rewriteSpend).toBeDefined();
    expect(Number(rewriteSpend?.costUsd)).toBeGreaterThan(0);
    // The heuristic triggered directly — no judge was consulted.
    expect(
      await getSideCostByMessageId({ messageId: arrivalId, kind: 'judge', model: env.JUDGE_MODEL }),
    ).toBeUndefined();
    // The judged signal is the rewrite's embedding, nearly identical despite
    // the float4 round-trip digit loss.
    expect(cosineSimilarity(row.embedding, readingVector(REWRITE))).toBeGreaterThan(0.9999);
    // Exactly one rewrite attempt landed.
    expect(mock.rewrites.requestCount() - rewritesBefore).toBe(1);
    // Turn 1 embeds twice (arrival + folded Turn), the arrival itself once.
    expect(mock.embeddings.requestCount() - embeddingsBefore).toBe(3);
    const view = await buildLiveAnalysisView({ threadId, mode: 'heuristic' });
    if (view.type !== 'success') throw new Error('view failed');
    const arrivalPoint = view.data.points.find((point) => point.messageId === arrivalId);
    expect(arrivalPoint?.expandOutcome).toBe('accepted');
    expect(arrivalPoint?.rewrittenText).toBe(REWRITE);
  });

  it('records a refusal and embeds the raw arrival: the fallback reading', async () => {
    mock.rewrites.forceReply(REFUSAL);
    const { threadId, arrivalId } = await seedRewriteThread();
    const rewritesBefore = mock.rewrites.requestCount();

    assertGateOk(await runLiveGate({ threadId, mode: 'heuristic' }));

    const row = await readArrivalRow(arrivalId);
    expect(row.expandOutcome).toBe('failed_refused');
    expect(row.expandedText).toBeNull();
    // The judged signal is the RAW arrival — the refusal never reaches the
    // embedding the way thread 1c36412d's did.
    expect(cosineSimilarity(row.embedding, readingVector(RAW_ARRIVAL))).toBeGreaterThan(0.9999);
    // …and it is not the rewrite's signal.
    expect(cosineSimilarity(row.embedding, readingVector(REWRITE))).toBeLessThan(0.5);
    // The budget held: the first attempt plus exactly one retry.
    expect(mock.rewrites.requestCount() - rewritesBefore).toBe(2);

    const view = await buildLiveAnalysisView({ threadId, mode: 'heuristic' });
    if (view.type !== 'success') throw new Error('view failed');
    const arrivalPoint = view.data.points.find((point) => point.messageId === arrivalId);
    expect(arrivalPoint?.expandOutcome).toBe('failed_refused');
    expect(arrivalPoint?.rewrittenText).toBeNull();
  });

  it('spends its one retry when the first attempt refuses and the second lands', async () => {
    mock.rewrites.replySequence([REFUSAL, REWRITE]);
    const { threadId, arrivalId } = await seedRewriteThread();
    const rewritesBefore = mock.rewrites.requestCount();

    assertGateOk(await runLiveGate({ threadId, mode: 'heuristic' }));

    const row = await readArrivalRow(arrivalId);
    expect(row.expandOutcome).toBe('accepted');
    expect(row.expandedText).toBe(REWRITE);
    expect(cosineSimilarity(row.embedding, readingVector(REWRITE))).toBeGreaterThan(0.9999);
    expect(mock.rewrites.requestCount() - rewritesBefore).toBe(2);
  });

  it('records an unusable echo as failed after the retry: raw reading stands', async () => {
    mock.rewrites.forceReply(RAW_ARRIVAL);
    const { threadId, arrivalId } = await seedRewriteThread();
    const rewritesBefore = mock.rewrites.requestCount();

    assertGateOk(await runLiveGate({ threadId, mode: 'heuristic' }));

    const row = await readArrivalRow(arrivalId);
    expect(row.expandOutcome).toBe('failed');
    expect(row.expandedText).toBeNull();
    expect(cosineSimilarity(row.embedding, readingVector(RAW_ARRIVAL))).toBeGreaterThan(0.9999);
    expect(mock.rewrites.requestCount() - rewritesBefore).toBe(2);
  });

  it('records an inference failure without retrying: the raw reading stands', async () => {
    mock.rewrites.failAll();
    const { threadId, arrivalId } = await seedRewriteThread();
    const rewritesBefore = mock.rewrites.requestCount();

    assertGateOk(await runLiveGate({ threadId, mode: 'heuristic' }));

    const row = await readArrivalRow(arrivalId);
    expect(row.expandOutcome).toBe('failed_inference');
    expect(row.expandedText).toBeNull();
    // The provider never billed the attempt — no side-cost row lands.
    expect(
      await getSideCostByMessageId({
        messageId: arrivalId,
        kind: 'rewrite',
        model: env.REWRITE_MODEL,
      }),
    ).toBeUndefined();
    expect(cosineSimilarity(row.embedding, readingVector(RAW_ARRIVAL))).toBeGreaterThan(0.9999);
    // Inference failure is not a quality failure — no retry is spent.
    expect(mock.rewrites.requestCount() - rewritesBefore).toBe(1);
  });

  it('never re-embeds on walk replay: the arrival row is the fixed point', async () => {
    mock.rewrites.forceReply(REWRITE);
    const { threadId } = await seedRewriteThread();

    assertGateOk(await runLiveGate({ threadId, mode: 'heuristic' }));
    const embeddingsAfterFirst = mock.embeddings.requestCount();
    const rewritesAfterFirst = mock.rewrites.requestCount();

    assertGateOk(await runLiveGate({ threadId, mode: 'heuristic' }));
    expect(mock.embeddings.requestCount()).toBe(embeddingsAfterFirst);
    // The rewrite step short-circuits on its stored row — no second loop.
    expect(mock.rewrites.requestCount()).toBe(rewritesAfterFirst);
  });
});

describe('runLiveGate — the mode picks when a rewrite is tried', () => {
  // Past the trigger length, so neither the anaphora heuristic nor the
  // judge's second look applies; only the `always` mode rewrites it.
  const LONG_ARRIVAL =
    'now please explain, at the same level of detail, how a beginner should keep a rye starter healthy, covering the feeding schedule, the hydration and the temperature of the kitchen';

  async function seedLongArrivalThread() {
    await insertUserIfNotExists({ id: USER_ID });
    const thread = await insertThread({ userId: USER_ID, title: 'long follow-up' });
    await insertMessage({ threadId: thread.id, role: 'user', content: FIRST_CONTENT });
    await insertMessage({ threadId: thread.id, role: 'assistant', content: FIRST_REPLY });
    const arrival = await insertMessage({
      threadId: thread.id,
      role: 'user',
      content: LONG_ARRIVAL,
    });
    return { threadId: thread.id, arrivalId: arrival.id };
  }

  it('leaves a long arrival unrewritten in heuristic mode', async () => {
    mock.rewrites.forceReply(REWRITE);
    const { threadId, arrivalId } = await seedLongArrivalThread();
    const rewritesBefore = mock.rewrites.requestCount();

    assertGateOk(await runLiveGate({ threadId, mode: 'heuristic' }));

    expect((await readArrivalRow(arrivalId)).expandOutcome).toBe('not_needed');
    expect(mock.rewrites.requestCount() - rewritesBefore).toBe(0);
  });

  it('rewrites a long arrival in always mode', async () => {
    mock.rewrites.forceReply(REWRITE);
    const { threadId, arrivalId } = await seedLongArrivalThread();
    const rewritesBefore = mock.rewrites.requestCount();

    assertGateOk(await runLiveGate({ threadId, mode: 'always' }));

    const row = await readArrivalRow(arrivalId);
    expect(row.expandOutcome).toBe('accepted');
    expect(row.expandedText).toBe(REWRITE);
    expect(mock.rewrites.requestCount() - rewritesBefore).toBe(1);
  });
});
