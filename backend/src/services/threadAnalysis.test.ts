import { randomUUID } from 'node:crypto';
import type { Message } from '@db/types';
import { listMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/listMessageEmbeddingsByMessageIds';
import { recordMessageEmbedding } from '@queries/messageEmbeddings/recordMessageEmbedding';
import { getMessageUsageByMessageId } from '@queries/messageUsage/getMessageUsageByMessageId';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import {
  DEFAULT_ANALYZE_OPTIONS,
  type DriftPoint,
  type RenderedThreadReport,
  type ThreadReport,
  type TopicSegmentTurn,
  analyzeThread,
  renderThreadReport,
} from '@services/threadAnalysis';
import { DEFAULT_USER_ID } from '@services/userService';
import { useTestDb } from '@test/test-db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type MockInferenceServer,
  buildMockEmbedding,
  countMockEmbeddingPromptTokens,
  startMockInferenceServer,
} from '../../mock/inferenceServer';

/**
 * Real e2e against the built-in mock inference server: the analysis seam
 * is exercised through `analyzeThread` only — returned report data,
 * persisted rows, and errors. No DB mocking.
 */

// The analyzer operates under the single-user placeholder (like every route).
const USER_ID = DEFAULT_USER_ID;

// Embedding price: $0.01 per 1M prompt tokens, used when the DB pricing
// table has no row for the embedding model.
const EMBEDDING_COST_PER_MILLION_USD = 0.01;

function expectedEmbeddingCostUsd(text: string): number {
  return Number(
    ((countMockEmbeddingPromptTokens(text) * EMBEDDING_COST_PER_MILLION_USD) / 1_000_000).toFixed(
      10,
    ),
  );
}

/** Accumulates per-block embedding costs the way the analyzer does. */
function sumEmbeddingCostUsd(texts: string[]): number {
  return texts.reduce((sum, text) => Number((sum + expectedEmbeddingCostUsd(text)).toFixed(10)), 0);
}

/** The frozen Turn text block . */
function turnBlock(user: string, assistant?: string): string {
  if (assistant === undefined || assistant === '') return `User:\n${user}\n\n`;
  return `User:\n${user}\n\nAssistant:\n${assistant}\n\n`;
}

/**
 * pgvector `vector(1024)` stores float4 — simulate the storage round-trip
 * so expected drift numbers match what `analyzeThread` computes from the
 * stored rows.
 */
function roundToFloat4(vector: number[]): number[] {
  return vector.map((value) => Math.fround(value));
}

/** Mirror of the analyzer's folder-private cosine distance. */
function cosineDistance(a: number[], b: number[]): number {
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

/** Mirror of the analyzer's folder-private centroid (Anchor + Gravity point). */
function centroidVector(vectors: number[][]): number[] {
  const first = vectors[0];
  if (!first) throw new Error('expected at least one vector');
  const mean = new Array<number>(first.length).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < vector.length; i += 1) mean[i] = (mean[i] ?? 0) + (vector[i] ?? 0);
  }
  for (let i = 0; i < mean.length; i += 1) mean[i] = (mean[i] ?? 0) / vectors.length;
  const norm = Math.sqrt(mean.reduce((sum, value) => sum + value * value, 0));
  return mean.map((value) => value / norm);
}

/**
 * The test mirror of the verdict tier's private state (the fields are
 * deliberately unpublished): the baseline's Welford running mean/sample σ
 * plus the Page–Hinkley patrol's accumulators.
 */
interface FoldMirror {
  members: number[][];
  count: number;
  mean: number;
  m2: number;
  pCount: number;
  pSum: number;
  cumulative: number;
  lowWater: number;
}

/** A calm reading joins the baseline; the patrol consumes the raw reading. Returns the slow fire. */
function mirrorAcceptAndPatrol(
  mirror: FoldMirror,
  drift: number,
  judging: typeof DEFAULT_ANALYZE_OPTIONS,
): boolean {
  mirror.count += 1;
  const d = drift - mirror.mean;
  mirror.mean += d / mirror.count;
  mirror.m2 += d * (drift - mirror.mean);
  mirror.pCount += 1;
  mirror.pSum += drift;
  mirror.cumulative += drift - mirror.pSum / mirror.pCount - judging.delta;
  if (mirror.cumulative < mirror.lowWater) mirror.lowWater = mirror.cumulative;
  return (
    mirror.pCount >= judging.minSamples && mirror.cumulative - mirror.lowWater >= judging.lambda
  );
}

/** Any verdict shreds the baseline and resets the patrol. */
function mirrorShred(mirror: FoldMirror): void {
  mirror.count = 0;
  mirror.mean = 0;
  mirror.m2 = 0;
  mirror.pCount = 0;
  mirror.pSum = 0;
  mirror.cumulative = 0;
  mirror.lowWater = 0;
}

/**
 * The two-channel verdict for one judged arrival: immediate against the
 * warm baseline (flat T_segment bootstraps), otherwise the calm reading
 * joins the baseline while the patrol may catch the slow class.
 */
function mirrorJudgeArrival(
  mirror: FoldMirror,
  drift: number,
  judging: typeof DEFAULT_ANALYZE_OPTIONS,
): boolean {
  const sigma = mirror.count < 2 ? null : Math.sqrt(mirror.m2 / Math.max(mirror.count - 1, 1));
  const warm = mirror.count >= 2;
  const threshold = warm
    ? mirror.mean + judging.immediateK * Math.max(sigma ?? 0, judging.sigmaFloor)
    : judging.segmentThreshold;
  return drift >= threshold || mirrorAcceptAndPatrol(mirror, drift, judging);
}

/**
 * Mirror of the analyzer's fold: judge first, fold second. Equal-weight
 * Gravity point over segment members; the SHARED two-channel verdict
 * judges the arrival against the segment's own state — the immediate
 * channel (z ≥ k over the warm baseline, T_segment as bootstrap prior)
 * then the slow patrol (raw readings at λ). A fire from either channel
 * is a Boundary turn: the baseline shreds, the rejected vector reseeds the
 * next Gravity point, and the first Turn seeds the opening segment with
 * no score.
 */
function expectedFold(
  vectors: number[][],
  judging: typeof DEFAULT_ANALYZE_OPTIONS,
): Array<{ segmentDrift: number | null; isBoundary: boolean }> {
  const points: Array<{ segmentDrift: number | null; isBoundary: boolean }> = [];
  const mirror: FoldMirror = {
    members: [],
    count: 0,
    mean: 0,
    m2: 0,
    pCount: 0,
    pSum: 0,
    cumulative: 0,
    lowWater: 0,
  };
  let completed = 0;
  for (const vector of vectors) {
    if (mirror.members.length === 0) {
      points.push({ segmentDrift: null, isBoundary: false });
      mirror.members = [vector];
      completed += 1;
      continue;
    }
    const drift = cosineDistance(vector, centroidVector(mirror.members));
    let isBoundary = false;
    if (completed >= judging.coldStartTurns) {
      isBoundary = mirrorJudgeArrival(mirror, drift, judging);
      if (isBoundary) mirrorShred(mirror);
    }
    points.push({ segmentDrift: drift, isBoundary });
    mirror.members = isBoundary ? [vector] : [...mirror.members, vector];
    completed += 1;
  }
  return points;
}

/**
 * The audit trail every judged Turn must record: the criterion it was
 * held to, and — for a Boundary turn — the channel that cut it.
 * (The fixtures are immediate-channel only: spikes fire, crawls stay
 * under λ per minSamples.)
 */
function expectJudgmentAudit(series: DriftPoint[]): void {
  for (const point of series.slice(1)) {
    expect(typeof point.immediateThreshold).toBe('number');
    if (point.isBoundary) expect(point.fireChannel).toBe('immediate');
  }
}

type TurnSpec = { user: string; assistant?: string; costUsd?: string };

/** Repeated texts embed to identical vectors — one Turn spec per topic mention. */
function topicTurn(topic: string): TurnSpec {
  return { user: `${topic} question`, assistant: `${topic} answer` };
}

/** The `TopicSegment.turns` rows a run over `specs` must report. */
function expectedTurnRows(specs: TurnSpec[], ...turnNumbers: number[]): TopicSegmentTurn[] {
  return turnNumbers.map((turnNumber) => {
    const spec = specs[turnNumber - 1];
    if (!spec) throw new Error(`no turn spec for turn ${turnNumber}`);
    return { turnNumber, userContent: spec.user, assistantContent: spec.assistant ?? null };
  });
}

/** Seed a thread owned by the default user; returns the inserted message rows in order. */
async function seedThread(
  title: string,
  specs: TurnSpec[],
): Promise<{
  threadId: string;
  messages: Message[];
}> {
  await insertUserIfNotExists({ id: USER_ID });
  const thread = await insertThread({ userId: USER_ID, title });
  const messages: Message[] = [];
  let turnIndex = 0;
  for (const spec of specs) {
    turnIndex += 1;
    const userMessage = await insertMessage({
      threadId: thread.id,
      role: 'user',
      content: spec.user,
    });
    messages.push(userMessage);
    if (spec.assistant === undefined) continue;
    const assistantMessage = await insertMessage({
      threadId: thread.id,
      role: 'assistant',
      content: spec.assistant,
    });
    messages.push(assistantMessage);
    if (spec.costUsd === undefined) continue;
    await insertMessageUsage({
      messageId: assistantMessage.id,
      model: 'test/chat-model',
      providerId: `local-turn-${turnIndex}`,
      promptTokens: 10,
      completionTokens: 5,
      costUsd: spec.costUsd,
      finishReason: 'stop',
    });
  }
  return { threadId: thread.id, messages };
}

function assertSuccess(result: Awaited<ReturnType<typeof analyzeThread>>): ThreadReport {
  expect(result.type).toBe('success');
  if (result.type !== 'success') throw new Error('expected success');
  return result.data;
}

/** Everything a re-run must reproduce identically (excludes per-run fields). */
function reproducibleReport(report: ThreadReport) {
  const { generatedAt: _generatedAt, totals, ...rest } = report;
  return {
    ...rest,
    totals: {
      turns: totals.turns,
      messages: totals.messages,
      totalCostUsd: totals.totalCostUsd,
    },
  };
}

/**
 * Vectors round-trip through pgvector `vector(1024)` (float4), so compare
 * with a tolerance — float4 storage keeps ~7 significant digits.
 */
function expectVectorClose(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(Math.abs((actual[i] ?? 0) - (expected[i] ?? 0))).toBeLessThan(1e-5);
  }
}

/**
 * Runs `fn` with no provider configured. '' values read as unset by
 * @config/env (empty-string guards in the getters), restoring the saved
 * state afterward without `delete`.
 */
async function withProviderUnconfigured<T>(fn: () => Promise<T>): Promise<T> {
  const previousMockUrl = process.env.MOCK_AI_BASE_URL;
  const previousApiKey = process.env.DEEPINFRA_API_KEY;
  process.env.MOCK_AI_BASE_URL = '';
  process.env.DEEPINFRA_API_KEY = '';
  try {
    return await fn();
  } finally {
    process.env.MOCK_AI_BASE_URL = previousMockUrl ?? '';
    process.env.DEEPINFRA_API_KEY = previousApiKey ?? '';
  }
}

// Single lifecycle hook for the whole file (see aiService.test.ts).
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
  mock.embeddings.clearFailures();
});

afterAll(async () => {
  // Restoring '' reads as unset by @config/env (empty-string guards in the
  // getters) — same pattern as aiService.test.ts avoids `delete`.
  process.env.MOCK_AI_BASE_URL = savedMockUrl ?? '';
  process.env.DEEPINFRA_API_KEY = savedApiKey ?? '';
  await mock.stop();
});

describe('analyzeThread — errors', () => {
  it('returns thread_not_found for unknown threads', async () => {
    const result = await analyzeThread(randomUUID());
    expect(result).toEqual({ type: 'error', code: 'thread_not_found' });
  });

  it('returns thread_too_short for Threads with no complete Turns', async () => {
    const empty = await seedThread('empty', []);
    const userOnly = await seedThread('user only', [{ user: 'unanswered question' }]);

    expect(await analyzeThread(empty.threadId)).toMatchObject({
      type: 'error',
      code: 'thread_too_short',
    });
    // A trailing user message without a reply completes no Turn.
    expect(await analyzeThread(userOnly.threadId)).toMatchObject({
      type: 'error',
      code: 'thread_too_short',
    });
  });

  it('returns provider_not_configured when neither mock nor real provider is set', async () => {
    const { threadId, messages } = await seedThread('needs embeddings', [
      { user: 'hello', assistant: 'hi' },
      { user: 'more', assistant: 'ok' },
    ]);

    const result = await withProviderUnconfigured(() => analyzeThread(threadId));

    expect(result).toMatchObject({ type: 'error', code: 'provider_not_configured' });
    // Nothing was persisted for the aborted run.
    const rows = await listMessageEmbeddingsByMessageIds({
      messageIds: messages.map((message) => message.id),
      modelId: EMBEDDING_MODEL_ID,
    });
    expect(rows).toEqual([]);
  });
});

describe('analyzeThread — report shell and cost profile', () => {
  it('builds the complete report shell and embeds every Turn', async () => {
    const { threadId, messages } = await seedThread('analysis thread', [
      { user: 'question one', assistant: 'answer one', costUsd: '0.0000012000' },
      { user: 'question two', assistant: 'answer two', costUsd: '0.0000034000' },
      { user: 'question three', assistant: 'answer three' }, // no usage row -> 0
    ]);
    const [a1, a2, a3] = [messages[1], messages[3], messages[5]];
    if (!a1 || !a2 || !a3) throw new Error('expected assistant rows');

    // Request accounting is server-wide — assert deltas, not absolute counts.
    const callsBefore = mock.embeddings.requestCount();
    const report = assertSuccess(await analyzeThread(threadId));

    expect(report.threadId).toBe(threadId);
    expect(report.title).toBe('analysis thread');
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(report.params).toEqual({
      ...DEFAULT_ANALYZE_OPTIONS,
      embeddingModelId: EMBEDDING_MODEL_ID,
    });

    // Cost profile defined at every message; marginal costs from stored
    // usage rows, missing rows contribute 0, running total spans the thread.
    expect(report.costProfile).toEqual([
      { messageIndex: 1, role: 'user', marginalCostUsd: 0, runningTotalUsd: 0 },
      {
        messageIndex: 2,
        role: 'assistant',
        marginalCostUsd: 0.0000012,
        runningTotalUsd: 0.0000012,
      },
      { messageIndex: 3, role: 'user', marginalCostUsd: 0, runningTotalUsd: 0.0000012 },
      {
        messageIndex: 4,
        role: 'assistant',
        marginalCostUsd: 0.0000034,
        runningTotalUsd: 0.0000046,
      },
      { messageIndex: 5, role: 'user', marginalCostUsd: 0, runningTotalUsd: 0.0000046 },
      { messageIndex: 6, role: 'assistant', marginalCostUsd: 0, runningTotalUsd: 0.0000046 },
    ]);

    expect(report.totals).toEqual({
      turns: 3,
      messages: 6,
      totalCostUsd: 0.0000046,
      embeddingCostUsd: sumEmbeddingCostUsd([
        turnBlock('question one', 'answer one'),
        turnBlock('question two', 'answer two'),
        turnBlock('question three', 'answer three'),
      ]),
      rewriteCostUsd: 0,
      judgeCostUsd: 0,
    });

    // Drift series scored from Turn 1 onward; the first Turn seeds the
    // opening Gravity point and carries no Segment drift. The Anchor IS
    // Segment 1: the mock's near-orthogonal topics flip the fold at
    // Turn 2, so Segment 1 leaves the Anchor as Turn 1 alone — and the
    // fold's own patrol on the Anchor wander turns advisory here: the
    // opening topic was abandoned immediately, so the sustained-rise
    // counsel records it at Turn 3 once the wander series has warmed.
    expect(report.anchor.builtFromTurns).toEqual([1, 1]);
    expect(report.anchor.counsel.map((row) => row.turnNumber)).toEqual([]);
    expect(report.driftSeries).toHaveLength(3);
    expect(report.driftSeries.map((point) => point.turnNumber)).toEqual([1, 2, 3]);
    expect(report.driftSeries.map((point) => point.messageIndex)).toEqual([2, 4, 6]);
    expect(report.driftSeries[0]?.segmentDrift).toBeNull(); // first scored Turn
    expect(report.driftSeries[0]?.driftScore).toBe(0);
    expect(report.driftSeries[1]?.segmentDrift).not.toBeNull();
    // Segments partition the Turns from Turn 1 and are labeled by the
    // segment's first user message.
    expect(report.segments[0]).toMatchObject({ index: 1, fromTurn: 1, label: 'question one' });
    expect(report.segments[report.segments.length - 1]?.toTurn).toBe(3);

    // One embed call per Turn, keyed to the Turn's assistant message.
    expect(mock.embeddings.requestCount() - callsBefore).toBe(3);

    // Persist-upon-use: rows exist with correct provenance and the
    // deterministic mock vectors of the frozen Turn text blocks. No row is
    // keyed to a user message.
    const rows = await listMessageEmbeddingsByMessageIds({
      messageIds: messages.map((message) => message.id),
      modelId: EMBEDDING_MODEL_ID,
    });
    expect(rows.map((row) => row.messageId).sort()).toEqual([a1.id, a2.id, a3.id].sort());
    for (const row of rows) {
      expect(row.modelId).toBe(EMBEDDING_MODEL_ID);
      expect(row.embedding).toHaveLength(1024);
    }
    const byMessage = new Map(rows.map((row) => [row.messageId, row.embedding]));
    expectVectorClose(
      byMessage.get(a1.id) ?? [],
      buildMockEmbedding(turnBlock('question one', 'answer one')),
    );
    expectVectorClose(
      byMessage.get(a2.id) ?? [],
      buildMockEmbedding(turnBlock('question two', 'answer two')),
    );
    expectVectorClose(
      byMessage.get(a3.id) ?? [],
      buildMockEmbedding(turnBlock('question three', 'answer three')),
    );
  });

  it('ignores a trailing message that does not complete a Turn', async () => {
    const { threadId, messages } = await seedThread('trailing user', [
      { user: 'q1', assistant: 'a1', costUsd: '0.0000001000' },
      { user: 'q2', assistant: 'a2', costUsd: '0.0000002000' },
      { user: 'unanswered trailing question' },
    ]);

    const callsBefore = mock.embeddings.requestCount();
    const report = assertSuccess(await analyzeThread(threadId));

    expect(report.totals).toMatchObject({ turns: 2, messages: 5 });
    expect(report.costProfile).toHaveLength(5);
    expect(report.costProfile[4]).toEqual({
      messageIndex: 5,
      role: 'user',
      marginalCostUsd: 0,
      runningTotalUsd: 0.0000003,
    });

    // Both complete Turns embed, each keyed to its assistant message.
    const [a1, a2] = [messages[1], messages[3]];
    if (!a1 || !a2) throw new Error('expected assistant rows');
    expect(mock.embeddings.requestCount() - callsBefore).toBe(2);
    const rows = await listMessageEmbeddingsByMessageIds({
      messageIds: messages.map((message) => message.id),
      modelId: EMBEDDING_MODEL_ID,
    });
    expect(rows.map((row) => row.messageId).sort()).toEqual([a1.id, a2.id].sort());
  });

  it('scores a single-Turn thread: null baseline, one segment, zero anchor distance', async () => {
    const { threadId } = await seedThread('one turn', [
      { user: 'only question', assistant: 'only answer', costUsd: '0.0000001000' },
    ]);

    const report = assertSuccess(await analyzeThread(threadId));

    // Segment 1 spans the whole one-Turn thread — the Anchor is that
    // single member; one sample cannot warm any detector, so the counsel
    // list is provably empty.
    expect(report.anchor).toEqual({ builtFromTurns: [1, 1], counsel: [] });
    expect(report.driftSeries).toEqual([
      {
        turnNumber: 1,
        messageIndex: 2,
        anchorDistance: expect.closeTo(0, 5),
        segmentDrift: null,
        driftScore: 0,
        isBoundary: false,
        boundaryReason: null,
      },
    ]);
    expect(report.segments).toEqual([
      {
        index: 1,
        fromTurn: 1,
        toTurn: 1,
        boundaryTurnNumber: null,
        label: 'only question',
        turns: [{ turnNumber: 1, userContent: 'only question', assistantContent: 'only answer' }],
      },
    ]);
  });
});

describe('analyzeThread — persistence, reuse and provenance', () => {
  it('makes zero embed calls on a re-run and returns identical report data', async () => {
    const { threadId } = await seedThread('reused turns', [
      { user: 'alpha topic', assistant: 'alpha reply', costUsd: '0.0000001000' },
      { user: 'beta topic', assistant: 'beta reply', costUsd: '0.0000002000' },
    ]);

    const first = assertSuccess(await analyzeThread(threadId));
    expect(first.totals.embeddingCostUsd).toBeGreaterThan(0);
    const callsAfterFirst = mock.embeddings.requestCount();

    const second = assertSuccess(await analyzeThread(threadId));

    expect(mock.embeddings.requestCount()).toBe(callsAfterFirst); // zero new calls
    expect(second.totals.embeddingCostUsd).toBe(0); // this run spent nothing
    expect(reproducibleReport(second)).toEqual(reproducibleReport(first));
  });

  it('re-embeds and upserts rows when the stored embedding model differs', async () => {
    const { threadId, messages } = await seedThread('provenance change', [
      { user: 'one', assistant: 'uno', costUsd: '0.0000001000' },
      { user: 'two', assistant: 'dos', costUsd: '0.0000002000' },
      { user: 'three', assistant: 'tres', costUsd: '0.0000003000' },
    ]);
    const [a1, a2, a3] = [messages[1], messages[3], messages[5]];
    if (!a1 || !a2 || !a3) throw new Error('expected assistant rows');

    // Rows stored under a different embedding model are stale geometry —
    // re-embedded, never compared (provenance identity = model_id, the architectural decision).
    for (const assistant of [a1, a2, a3]) {
      await recordMessageEmbedding({
        messageId: assistant.id,
        embedding: buildMockEmbedding('stale geometry fixture'),
        modelId: 'stale/embed-model',
      });
    }

    const callsBefore = mock.embeddings.requestCount();
    const report = assertSuccess(await analyzeThread(threadId));
    expect(mock.embeddings.requestCount() - callsBefore).toBe(3); // all Turn rows re-embedded
    expect(report.totals.embeddingCostUsd).toBeGreaterThan(0);

    // Upsert, not duplicate: still 1:1 with the Turn's assistant message,
    // now carrying the current model and the correct Turn vectors.
    const rows = await listMessageEmbeddingsByMessageIds({
      messageIds: [a1.id, a2.id, a3.id],
      modelId: EMBEDDING_MODEL_ID,
    });
    expect(rows.map((row) => row.messageId).sort()).toEqual([a1.id, a2.id, a3.id].sort());
    for (const row of rows) {
      expect(row.modelId).toBe(EMBEDDING_MODEL_ID);
    }
    const byMessage = new Map(rows.map((row) => [row.messageId, row.embedding]));
    expectVectorClose(byMessage.get(a3.id) ?? [], buildMockEmbedding(turnBlock('three', 'tres')));
  });

  it('aborts an injected embed failure and resumes from the first un-embedded Turn', async () => {
    const { threadId, messages } = await seedThread('abort and resume', [
      { user: 't1', assistant: 'r1' },
      { user: 't2', assistant: 'r2' },
      { user: 't3', assistant: 'r3' },
      { user: 't4', assistant: 'r4' },
    ]);
    const [a1, a2, a3, a4] = [messages[1], messages[3], messages[5], messages[7]];
    if (!a1 || !a2 || !a3 || !a4) throw new Error('expected assistant rows');

    // Second NEW request onward fails: Turn 1 embeds and persists, then abort.
    mock.embeddings.failFrom(mock.embeddings.requestCount() + 2);
    const failed = await analyzeThread(threadId);
    expect(failed).toMatchObject({ type: 'error', code: 'embed_failed' });

    const partialRows = await listMessageEmbeddingsByMessageIds({
      messageIds: [a1.id, a2.id, a3.id, a4.id],
      modelId: EMBEDDING_MODEL_ID,
    });
    expect(partialRows.map((row) => row.messageId)).toEqual([a1.id]); // progress survives

    // Healthy re-run continues from the first un-embedded Turn.
    mock.embeddings.clearFailures();
    const callsBeforeResume = mock.embeddings.requestCount();
    const report = assertSuccess(await analyzeThread(threadId));

    expect(mock.embeddings.requestCount()).toBe(callsBeforeResume + 3); // only Turns 2, 3, 4
    const rows = await listMessageEmbeddingsByMessageIds({
      messageIds: [a1.id, a2.id, a3.id, a4.id],
      modelId: EMBEDDING_MODEL_ID,
    });
    expect(rows.map((row) => row.messageId).sort()).toEqual([a1.id, a2.id, a3.id, a4.id].sort());
    expect(report.totals).toMatchObject({ turns: 4, messages: 8 });
    // This run's spend: the three resumed embed calls only.
    expect(report.totals.embeddingCostUsd).toBe(
      sumEmbeddingCostUsd([turnBlock('t2', 'r2'), turnBlock('t3', 'r3'), turnBlock('t4', 'r4')]),
    );
  });
});

describe('analyzeThread — Segment drift scoring and segmentation', () => {
  // The acceptance-shape reference: five topics held as repeated texts —
  // mock vectors are deterministic and content-seeded, so repeated texts
  // embed to identical vectors (Segment drift ≈ 0, joins) while fresh
  // topics are near-orthogonal (Segment drift ≈ 1, Boundary turns at the
  // default T_segment 0.52).
  const multiTopicSpecs: TurnSpec[] = [
    topicTurn('lifting'),
    topicTurn('flowers'),
    topicTurn('flowers'),
    topicTurn('cars'),
    topicTurn('cars'),
    topicTurn('weather'),
    topicTurn('weather'),
    topicTurn('umbrella'),
    topicTurn('umbrella'),
    topicTurn('umbrella'),
  ];

  /** Stored-vector expectations for the reference fixture. */
  function referenceVectors(): number[][] {
    return multiTopicSpecs.map((spec) =>
      roundToFloat4(buildMockEmbedding(turnBlock(spec.user, spec.assistant))),
    );
  }

  it('scores Anchor distance, Segment drift and clamped Drift score per Turn', async () => {
    const { threadId } = await seedThread('multi-topic drift', multiTopicSpecs);
    const report = assertSuccess(await analyzeThread(threadId));

    const vectors = referenceVectors();
    const expected = expectedFold(vectors, DEFAULT_ANALYZE_OPTIONS);

    // The Anchor IS Segment 1: the fixture's first topic
    // flips at Turn 2, so Segment 1 is Turn 1 alone and the Anchor is
    // its vector — the pure opening topic.
    const anchor = (vectors[0] ?? []) as number[];
    expect(report.anchor.builtFromTurns).toEqual([1, 1]);
    expect(report.driftSeries).toHaveLength(10);

    for (let i = 0; i < expected.length; i += 1) {
      const point = report.driftSeries[i];
      const exp = expected[i];
      if (!point || !exp) throw new Error('expected drift point');
      expect(point.turnNumber).toBe(i + 1);
      expect(point.messageIndex).toBe(2 * (i + 1)); // the Turn's assistant message
      expect(point.anchorDistance).toBeCloseTo(cosineDistance(vectors[i] ?? [], anchor), 5);
      if (exp.segmentDrift === null) expect(point.segmentDrift).toBeNull();
      else expect(point.segmentDrift).toBeCloseTo(exp.segmentDrift, 5);
      // Drift score = clamp(Segment drift, 0, 1) — null clamps to 0.
      expect(point.driftScore).toBeCloseTo(Math.min(1, exp.segmentDrift ?? 0), 5);
      expect(point.isBoundary).toBe(exp.isBoundary);
    }

    // Audit trail: every non-seed Turn records its judgment, and a
    // Boundary Turn names the channel that cut it.
    expectJudgmentAudit(report.driftSeries);

    // Segment drift is null on the first scored Turn only.
    expect(report.driftSeries[0]?.segmentDrift).toBeNull();
    expect(report.driftSeries[1]?.segmentDrift).not.toBeNull();
  });

  it('joins fold into the rolling Gravity point', async () => {
    // Distinct texts are near-orthogonal (drift ≈ 1): only a loose
    // threshold lets them all join, exposing the rolling centroid — each
    // Turn is scored against the mean of every member before it, not just
    // the segment opener.
    const specs = [topicTurn('alpha'), topicTurn('beta'), topicTurn('gamma'), topicTurn('delta')];
    const { threadId } = await seedThread('rolling gravity', specs);

    const report = assertSuccess(
      await analyzeThread(threadId, { segmentThreshold: 1.5, immediateK: 100, lambda: 100 }),
    );

    const vectors = multiVector(['alpha', 'beta', 'gamma', 'delta']);
    expect(report.driftSeries[0]?.segmentDrift).toBeNull();
    expect(report.driftSeries[1]?.segmentDrift).toBeCloseTo(
      cosineDistance(vectors[1] ?? [], vectors[0] ?? []),
      5,
    );
    expect(report.driftSeries[2]?.segmentDrift).toBeCloseTo(
      cosineDistance(vectors[2] ?? [], centroidVector(vectors.slice(0, 2))),
      5,
    );
    expect(report.driftSeries[3]?.segmentDrift).toBeCloseTo(
      cosineDistance(vectors[3] ?? [], centroidVector(vectors.slice(0, 3))),
      5,
    );
    expect(report.driftSeries.every((point) => !point.isBoundary)).toBe(true);
    expect(report.segments).toEqual([
      {
        index: 1,
        fromTurn: 1,
        toTurn: 4,
        boundaryTurnNumber: null,
        label: 'alpha question',
        turns: expectedTurnRows(specs, 1, 2, 3, 4),
      },
    ]);
  });

  it('Boundary turns reseed the Gravity point', async () => {
    // alpha / beta / beta / alpha: Turn 2 crosses and seeds beta; Turn 3
    // must measure ≈ 0 against the RESEEDED Gravity point (it would read
    // ≈ 1 against the old alpha segment); Turn 4's return to alpha is a
    // Boundary turn like any other — a change back is still a change.
    const specs = [topicTurn('alpha'), topicTurn('beta'), topicTurn('beta'), topicTurn('alpha')];
    const { threadId } = await seedThread('reseed', specs);

    const report = assertSuccess(await analyzeThread(threadId));

    const [vAlpha, vBeta] = multiVector(['alpha', 'beta']);
    if (!vAlpha || !vBeta) throw new Error('expected vectors');
    expect(report.driftSeries.map((point) => point.isBoundary)).toEqual([false, true, false, true]);
    expect(report.driftSeries[1]?.segmentDrift).toBeCloseTo(cosineDistance(vBeta, vAlpha), 5);
    // The reseed is the observable: measured against the new segment.
    expect(report.driftSeries[2]?.segmentDrift).toBeCloseTo(0, 5);
    expect(report.driftSeries[3]?.segmentDrift).toBeCloseTo(cosineDistance(vAlpha, vBeta), 5);
    expect(report.driftSeries.map((point) => point.boundaryReason)).toEqual([
      null,
      'segment',
      null,
      'segment',
    ]);
    expect(report.segments).toEqual([
      {
        index: 1,
        fromTurn: 1,
        toTurn: 1,
        boundaryTurnNumber: null,
        label: 'alpha question',
        turns: expectedTurnRows(specs, 1),
      },
      {
        index: 2,
        fromTurn: 2,
        toTurn: 3,
        boundaryTurnNumber: 2,
        label: 'beta question',
        turns: expectedTurnRows(specs, 2, 3),
      },
      {
        index: 3,
        fromTurn: 4,
        toTurn: 4,
        boundaryTurnNumber: 4,
        label: 'alpha question',
        turns: expectedTurnRows(specs, 4),
      },
    ]);
  });

  it('multi-segment run cuts the seeded topics exactly', async () => {
    const { threadId } = await seedThread('multi-topic boundaries', multiTopicSpecs);
    const report = assertSuccess(await analyzeThread(threadId)); // default T_segment = 0.52

    // The sealed-in expectations: one segment per seeded topic —
    // 1 / 2-3 / 4-5 / 6-7 / 8-10.
    expect(
      report.driftSeries.map((point) => [point.turnNumber, point.isBoundary, point.boundaryReason]),
    ).toEqual([
      [1, false, null],
      [2, true, 'segment'],
      [3, false, null],
      [4, true, 'segment'],
      [5, false, null],
      [6, true, 'segment'],
      [7, false, null],
      [8, true, 'segment'],
      [9, false, null],
      [10, false, null],
    ]);
    expect(report.segments).toEqual([
      {
        index: 1,
        fromTurn: 1,
        toTurn: 1,
        boundaryTurnNumber: null,
        label: 'lifting question',
        turns: expectedTurnRows(multiTopicSpecs, 1),
      },
      {
        index: 2,
        fromTurn: 2,
        toTurn: 3,
        boundaryTurnNumber: 2,
        label: 'flowers question',
        turns: expectedTurnRows(multiTopicSpecs, 2, 3),
      },
      {
        index: 3,
        fromTurn: 4,
        toTurn: 5,
        boundaryTurnNumber: 4,
        label: 'cars question',
        turns: expectedTurnRows(multiTopicSpecs, 4, 5),
      },
      {
        index: 4,
        fromTurn: 6,
        toTurn: 7,
        boundaryTurnNumber: 6,
        label: 'weather question',
        turns: expectedTurnRows(multiTopicSpecs, 6, 7),
      },
      {
        index: 5,
        fromTurn: 8,
        toTurn: 10,
        boundaryTurnNumber: 8,
        label: 'umbrella question',
        turns: expectedTurnRows(multiTopicSpecs, 8, 9, 10),
      },
    ]);
  });

  it('reclassifies Boundaries and segments with zero new embed calls when the threshold changes', async () => {
    const { threadId } = await seedThread('threshold re-run', multiTopicSpecs);

    const callsBefore = mock.embeddings.requestCount();
    const first = assertSuccess(await analyzeThread(threadId)); // T_segment = 0.52
    expect(mock.embeddings.requestCount()).toBe(callsBefore + 10); // one per Turn

    // A threshold above any possible drift: zero boundaries, one segment.
    // The flat override also silences the immediate channel so warm-baseline
    // levels cannot cut either.
    const second = assertSuccess(
      await analyzeThread(threadId, { segmentThreshold: 1.5, immediateK: 100, lambda: 100 }),
    );
    expect(mock.embeddings.requestCount()).toBe(callsBefore + 10); // zero new calls
    expect(second.totals.embeddingCostUsd).toBe(0); // this run spent nothing
    expect(second.driftSeries.every((point) => !point.isBoundary)).toBe(true);
    // The Anchor follows Segment 1, and Segment 1 follows the threshold:
    // the default run's segment never made it past Turn 1, while this
    // run's single all-thread segment makes the Anchor every member.
    expect(first.anchor.builtFromTurns).toEqual([1, 1]);
    expect(second.anchor.builtFromTurns).toEqual([1, 10]);
    expect(second.segments).toEqual([
      {
        index: 1,
        fromTurn: 1,
        toTurn: 10,
        boundaryTurnNumber: null,
        label: 'lifting question',
        turns: expectedTurnRows(multiTopicSpecs, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
      },
    ]);

    // Default thresholds still cut the seeded topics on the stored
    // vectors — same fold, same Segment 1, therefore the identical
    // Anchor wander series across same-threshold re-runs.
    const third = assertSuccess(await analyzeThread(threadId));
    expect(mock.embeddings.requestCount()).toBe(callsBefore + 10);
    expect(third.segments.map((segment) => [segment.fromTurn, segment.toTurn])).toEqual(
      first.segments.map((segment) => [segment.fromTurn, segment.toTurn]),
    );
    expect(third.driftSeries.map((point) => point.anchorDistance)).toEqual(
      first.driftSeries.map((point) => point.anchorDistance),
    );
  });

  it('the Anchor is Segment 1: a Turn-2 flip locks it on Turn 1 alone, an uncut opening claims the whole theme', async () => {
    const { threadId } = await seedThread('short anchor', [
      { user: 'one', assistant: 'uno' },
      { user: 'two', assistant: 'dos' },
    ]);

    // Two near-orthogonal topics → the fold flips at Turn 2, so Segment
    // 1 stays Turn 1 alone and the Anchor refuses everything after it.
    // Two wander samples cannot warm the patrol (minSamples ≥ 3), so the
    // counsel list stays provably empty.
    const report = assertSuccess(await analyzeThread(threadId));
    expect(report.anchor).toEqual({ builtFromTurns: [1, 1], counsel: [] });

    const vectors = multiVector2('one', 'uno', 'two', 'dos');
    const anchor = (vectors[0] ?? []) as number[];
    expect(report.driftSeries[0]?.anchorDistance).toBeCloseTo(
      cosineDistance(vectors[0] ?? [], anchor),
      5,
    );
    expect(report.driftSeries[1]?.anchorDistance).toBeCloseTo(
      cosineDistance(vectors[1] ?? [], anchor),
      5,
    );

    // The same thread with a threshold nothing crosses: no cut, so
    // Segment 1 is the whole opening theme and the Anchor its centroid
    // — its members sit symmetric around it, none at distance zero.
    // (Immediate channel silenced too, so warm-baseline levels cannot cut.)
    const uncut = assertSuccess(
      await analyzeThread(threadId, { segmentThreshold: 1.5, immediateK: 100, lambda: 100 }),
    );
    expect(uncut.anchor).toEqual({ builtFromTurns: [1, 2], counsel: [] });
    const whole = centroidVector(vectors);
    expect(uncut.driftSeries[0]?.anchorDistance).toBeCloseTo(
      cosineDistance(vectors[0] ?? [], whole),
      5,
    );
    expect(uncut.driftSeries[1]?.anchorDistance).toBeCloseTo(
      cosineDistance(vectors[1] ?? [], whole),
      5,
    );
  });

  it('a return to the opening topic reads as Anchor distance falling', async () => {
    // The opening flip leaves the Anchor on Turn 1 alone; the thread
    // wanders to beta and returns to alpha — the charted Anchor series
    // self-heals while Segment drift still flags the return as a
    // Boundary turn.
    const { threadId } = await seedThread('return home', [
      topicTurn('alpha'),
      topicTurn('beta'),
      topicTurn('beta'),
      topicTurn('alpha'),
    ]);

    const report = assertSuccess(await analyzeThread(threadId));

    const [vAlpha, vBeta] = multiVector(['alpha', 'beta']);
    if (!vAlpha || !vBeta) throw new Error('expected vectors');
    const wander = cosineDistance(vBeta, vAlpha);
    expect(report.driftSeries[0]?.anchorDistance).toBeCloseTo(0, 5);
    expect(report.driftSeries[1]?.anchorDistance).toBeCloseTo(wander, 5);
    expect(report.driftSeries[3]?.anchorDistance).toBeCloseTo(0, 5); // back home
  });

  /** Stored Turn vectors, one per topic text (mock determinism). */
  function multiVector(topics: string[]): number[][] {
    return topics.map((topic) =>
      roundToFloat4(buildMockEmbedding(turnBlock(`${topic} question`, `${topic} answer`))),
    );
  }

  function multiVector2(u1: string, a1: string, u2: string, a2: string): number[][] {
    return [turnBlock(u1, a1), turnBlock(u2, a2)].map((block) =>
      roundToFloat4(buildMockEmbedding(block)),
    );
  }
});

describe('analyzeThread — data safety', () => {
  it('never mutates messages, threads, or message_usage', async () => {
    const { threadId } = await seedThread('read only', [
      { user: 'keep me', assistant: 'and me', costUsd: '0.0000009000' },
      { user: 'also keep me', assistant: 'me too', costUsd: '0.0000001100' },
    ]);

    const threadsBefore = await findThreadSnapshot(threadId);
    const messagesBefore = await listMessagesByThread({ threadId });
    const usageBefore = await Promise.all(
      messagesBefore
        .filter((message) => message.role === 'assistant')
        .map((message) => getMessageUsageByMessageId({ messageId: message.id })),
    );

    assertSuccess(await analyzeThread(threadId));

    expect(await findThreadSnapshot(threadId)).toEqual(threadsBefore);
    expect(await listMessagesByThread({ threadId })).toEqual(messagesBefore);
    expect(
      await Promise.all(
        messagesBefore
          .filter((message) => message.role === 'assistant')
          .map((message) => getMessageUsageByMessageId({ messageId: message.id })),
      ),
    ).toEqual(usageBefore);
  });
});

describe('analyzeThread — turn progress', () => {
  it('fires once per embed call with the turn position, never on reused runs', async () => {
    const { threadId } = await seedThread('progress hook', [
      { user: 'p1', assistant: 'r1' },
      { user: 'p2', assistant: 'r2' },
      { user: 'p3', assistant: 'r3' },
    ]);

    const firstRun: Array<[number, number]> = [];
    assertSuccess(
      await analyzeThread(threadId, {
        onTurnEmbedded: (turnNumber, totalTurns) => firstRun.push([turnNumber, totalTurns]),
      }),
    );
    // Three Turns, reported before each embed call.
    expect(firstRun).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);

    const secondRun: Array<[number, number]> = [];
    assertSuccess(
      await analyzeThread(threadId, {
        onTurnEmbedded: (turnNumber, totalTurns) => secondRun.push([turnNumber, totalTurns]),
      }),
    );
    // Provenance reuse: zero embed calls, so zero progress events.
    expect(secondRun).toEqual([]);
  });
});

describe('analyzeThread — rendering the produced report', () => {
  it('renders offline HTML plus a JSON sidecar that round-trips to the identical report', async () => {
    const { threadId } = await seedThread('render me', [
      { user: 'aaa one', assistant: 'bbb one', costUsd: '0.0000001000' },
      { user: 'ccc two', assistant: 'ddd two', costUsd: '0.0000002000' },
      { user: 'eee three', assistant: 'fff three' },
    ]);
    const report = assertSuccess(await analyzeThread(threadId));

    const { html, json } = renderThreadReport(report);

    // The sidecar parses back to the identical ThreadReport.
    expect(JSON.parse(json)).toEqual(report);
    // The HTML is fully self-contained: inline SVG chart and an inline
    // toggle script, but zero external references (no URLs, no
    // link/img/iframe, no src attributes) — opens offline anywhere.
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<link|<img|<iframe|\bsrc\s*=/i);
    expect(html).toMatch(/<svg[ >]/);
    expect(html).toMatch(/<script>/);
    expect(html).toContain(report.threadId);
    // Segment labels reach the table; params and totals reach the header.
    expect(html).toContain('ccc two');
    expect(html).toContain('Segment drift');
    expect(html).toContain('BAAI/bge-m3');
    expect(html).toContain('$0.000000');
  });
});

describe('renderThreadReport — pure rendering', () => {
  /** A decision-rich fixture: cost, drift, boundaries, segments, hostile text. */
  function fixtureReport(): ThreadReport {
    return {
      threadId: '11111111-2222-4333-8444-555555555555',
      title: 'Render <script>alert(1)</script> & fixture',
      generatedAt: '2026-01-02T03:04:05.678Z',
      params: {
        segmentThreshold: 0.35,
        immediateK: 2,
        sigmaFloor: 0.02,
        lambda: 0.5,
        delta: 0,
        minSamples: 3,
        coldStartTurns: 1,
        embeddingModelId: 'test/embed-model',
      },
      totals: {
        turns: 4,
        messages: 8,
        totalCostUsd: 0.0000123,
        embeddingCostUsd: 0.0000004,
        rewriteCostUsd: 0,
        judgeCostUsd: 0,
      },
      costProfile: [
        { messageIndex: 1, role: 'user', marginalCostUsd: 0, runningTotalUsd: 0 },
        {
          messageIndex: 2,
          role: 'assistant',
          marginalCostUsd: 0.000004,
          runningTotalUsd: 0.000004,
        },
        { messageIndex: 3, role: 'user', marginalCostUsd: 0, runningTotalUsd: 0.000004 },
        {
          messageIndex: 4,
          role: 'assistant',
          marginalCostUsd: 0.000003,
          runningTotalUsd: 0.000007,
        },
        { messageIndex: 5, role: 'user', marginalCostUsd: 0, runningTotalUsd: 0.000007 },
        {
          messageIndex: 6,
          role: 'assistant',
          marginalCostUsd: 0.0000053,
          runningTotalUsd: 0.0000123,
        },
        { messageIndex: 7, role: 'user', marginalCostUsd: 0, runningTotalUsd: 0.0000123 },
        { messageIndex: 8, role: 'assistant', marginalCostUsd: 0, runningTotalUsd: 0.0000123 },
      ],
      driftSeries: [
        {
          turnNumber: 1,
          messageIndex: 2,
          anchorDistance: 0.0,
          segmentDrift: null,
          driftScore: 0,
          isBoundary: false,
          boundaryReason: null,
        },
        {
          turnNumber: 2,
          messageIndex: 4,
          anchorDistance: 0.45,
          segmentDrift: 0.41,
          driftScore: 0.41,
          isBoundary: true,
          boundaryReason: 'segment',
        },
        {
          turnNumber: 3,
          messageIndex: 6,
          anchorDistance: 0.4,
          segmentDrift: 0.12,
          driftScore: 0.12,
          isBoundary: false,
          boundaryReason: null,
        },
        {
          turnNumber: 4,
          messageIndex: 8,
          anchorDistance: 0.5,
          segmentDrift: 0.44,
          driftScore: 0.44,
          isBoundary: true,
          boundaryReason: 'segment',
        },
      ],
      anchor: { builtFromTurns: [1, 1], counsel: [] },
      segments: [
        {
          index: 1,
          fromTurn: 1,
          toTurn: 1,
          boundaryTurnNumber: null,
          label: 'First topic <one> & co',
          turns: [
            {
              turnNumber: 1,
              userContent: 'First topic <one> & co',
              assistantContent: 'first answer',
            },
          ],
        },
        {
          index: 2,
          fromTurn: 2,
          toTurn: 3,
          boundaryTurnNumber: 2,
          label: 'Second topic',
          turns: [
            {
              turnNumber: 2,
              userContent: 'Second topic',
              assistantContent: 'second answer <b>bold</b>',
            },
            { turnNumber: 3, userContent: 'third question', assistantContent: 'third answer' },
          ],
        },
        {
          index: 3,
          fromTurn: 4,
          toTurn: 4,
          boundaryTurnNumber: 4,
          label: 'Third topic',
          turns: [{ turnNumber: 4, userContent: 'Third topic', assistantContent: null }],
        },
      ],
    };
  }

  function countMatches(haystack: string, pattern: RegExp): number {
    return (haystack.match(pattern) ?? []).length;
  }

  it('serializes the JSON sidecar back to the identical ThreadReport', () => {
    const report = fixtureReport();
    expect(JSON.parse(renderThreadReport(report).json)).toEqual(report);
  });

  it('produces fully self-contained HTML with no external references', () => {
    const { html } = renderThreadReport(fixtureReport());
    expect(html).not.toMatch(/https?:\/\//i); // no URLs at all (not even SVG xmlns)
    // No external references; the inline toggle script is the only
    // <script> in the document and carries no attributes (no src).
    expect(html).not.toMatch(/<link|@import|\ssrc=|\shref=/i);
    expect(countMatches(html, /<script>/g)).toBe(1);
    expect(html).toMatch(/<svg[ >]/);
    expect(html).toContain('</svg>');
    expect(html).toContain('<style>');
  });

  it('escapes hostile thread text instead of injecting markup', () => {
    const { html } = renderThreadReport(fixtureReport());
    // Exactly the toggle script — the hostile title stays escaped.
    expect(countMatches(html, /<script>/g)).toBe(1);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('First topic &lt;one&gt; &amp; co');
  });

  it('embeds both chart kinds on the shared turn axis with marks and reference lines', () => {
    const { html } = renderThreadReport(fixtureReport());
    // Turn axis: the chart speaks turns like the segment table does.
    expect(html).toContain('>turn number<');
    // Cost series: one marginal bar per Turn with spend (3 Turns here —
    // the fourth assistant row carried no usage) + running total.
    expect(countMatches(html, /class="bar-marginal"/g)).toBe(3);
    expect(html).toContain('class="series-running-total"');
    // Drift series: Anchor distance (solid) + Segment drift (dashed, only
    // non-null points). The Drift score is the clamped Segment drift and
    // gets no separate polyline.
    expect(html).toContain('class="series-anchor-distance"');
    expect(html).toContain('class="series-segment-drift"');
    expect(html).not.toContain('series-drift-score');
    expect(html).not.toContain('series-local-delta');
    // Coincident series stay legible: Segment drift carries a dash
    // pattern (Anchor distance stays solid).
    expect(countMatches(html, /stroke-dasharray="7 4"/g)).toBe(1);
    // One vertical boundary mark per Boundary turn, one reference line —
    // Segment drift is the single Boundary-turn authority. The line is
    // colour- and label-bound to the offline fold so readers never apply
    // it to the live (purple) lane.
    expect(countMatches(html, /class="boundary-mark"/g)).toBe(2);
    expect(countMatches(html, /class="threshold-line"/g)).toBe(1);
    expect(html).toContain('segment threshold (bootstrap prior) 0.35');
    const thresholdGroup = html.match(/<g class="threshold-line">[\s\S]*?<\/g>/)?.[0] ?? '';
    expect(thresholdGroup).toContain('stroke="#ef6c00"');
    expect(html).not.toContain('anchor threshold');
    expect(html).not.toContain('local threshold');
    // An offline-only report gets the offline chart alone — no live chart,
    // no live trigger, no z panel.
    expect(html).not.toContain('chart-live');
    expect(html).not.toContain('series-live-trigger');
    // Toggleable families: the inline script shows/hides data-toggle
    // groups; the control bar above the chart drives them, and every
    // segment carries a hoverable ?-mark with its messages in a popover.
    expect(html).toContain('data-toggle="cost"');
    expect(html).toContain('data-toggle="anchor"');
    expect(html).toContain('data-toggle="segments"');
    expect(html).toContain('data-controls="offline"');
    expect(countMatches(html, /class="segment-badge"/g)).toBe(3);
    expect(countMatches(html, /class="segment-popover"/g)).toBe(3);
    expect(html).toContain('id="segment-pop-1"');
    // Cost is context, not signal: drawn thin + pale.
    const costLine = html.match(/series-running-total[^>]*>/)?.[0] ?? '';
    expect(costLine).toContain('stroke-width="1"');
    expect(html).toContain('opacity="0.45"');
  });

  it('prints the run params and totals in the meta header', () => {
    const { html } = renderThreadReport(fixtureReport());
    expect(html).toContain('2026-01-02T03:04:05.678Z');
    expect(html).toContain('test/embed-model');
    expect(html).toContain('Anchor built from turns');
    expect(html).toContain('Segment threshold (T_segment, bootstrap prior)');
    expect(html).toContain('0.35');
    expect(html).not.toContain('Window size');
    expect(html).toContain('$0.000012'); // total cost
    expect(html).toContain('$0.000000'); // this run's embedding cost rounds here
    expect(html).toContain('1–1'); // anchor provenance: Segment 1's turns
  });

  it('lists every topic segment with all its messages', () => {
    const { html } = renderThreadReport(fixtureReport());
    expect(countMatches(html, /class="segment-row"/g)).toBe(3);
    expect(html).toContain('<th>Messages</th>');
    // Every Turn's messages appear in their segment's row, escaped.
    expect(html).toContain('T1 user:</span>First topic &lt;one&gt; &amp; co');
    expect(html).toContain('T2 user:</span>Second topic');
    expect(html).toContain('T2 assistant:</span>second answer &lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('T3 user:</span>third question');
    expect(html).toContain('T3 assistant:</span>third answer');
    // A Turn without an assistant reply renders the user line only.
    expect(html).toContain('T4 user:</span>Third topic');
    expect(html).not.toContain('T4 assistant:');
    // The opening segment carries no boundary turn.
    expect(html).toContain('—');
  });

  /** The same thread after a gate-replay run with baseline readings. */
  function gateFixtureReport(): ThreadReport {
    const base = fixtureReport();
    return {
      ...base,
      params: {
        ...base.params,
        immediateK: 2,
        sigmaFloor: 0.02,
        lambda: 1.0,
        delta: 0,
        minSamples: 2,
        coldStartTurns: 1,
        gateReplay: { sinkhornEpsilon: 0.05 },
      },
      // The fold's own Anchor-wander counsel carries this row — the ring
      // on the offline chart's blue line (the live side's patrol rows are
      // plain prospected, no re-judgment).
      anchor: { ...base.anchor, counsel: [{ turnNumber: 5, anchorDistance: 0.5 }] },
      gateReplay: {
        points: [
          {
            turnNumber: 1,
            messageIndex: 1,
            driftP: null,
            driftPGated: null,
            anchorDistance: 0.1,
            verdict: 'muted',
          },
          {
            turnNumber: 2,
            messageIndex: 3,
            driftP: 0.2,
            driftPGated: 0.2,
            anchorDistance: 0.2,
            // Bootstrap: the baseline is empty — the constant judges,
            // nothing to chart yet. The corrected patrol, though, warms
            // from its first consumed step: this very raw reading.
            immediateThreshold: 0.35,
            gateMean: 0.2,
            gateRise: 0,
            verdict: 'pass',
          },
          {
            turnNumber: 3,
            messageIndex: 5,
            driftP: 0.21,
            driftPGated: 0.21,
            anchorDistance: 0.22,
            // Still bootstrapping (1 accepted member): flat constant, no
            // z — but the baseline's mean already charts. The patrol took
            // its second raw drift step: baseline (0.2 + 0.21)/2, the
            // beginning of an accumulated rise.
            immediateThreshold: 0.35,
            segmentMu: 0.2,
            segmentSigma: null,
            gateMean: 0.205,
            gateRise: 0.005,
            verdict: 'pass',
          },
          {
            turnNumber: 4,
            messageIndex: 7,
            driftP: 0.24,
            driftPGated: 0.24,
            anchorDistance: 0.24,
            // The baseline speaks: μ + k·σ_eff = 0.245 (σ below the floor);
            // z = 1.75 stays under k = 2 — pass, the patrol keeps rising
            // on the raw drift steps (its third, against its own mean).
            immediateThreshold: 0.245,
            immediateZ: 1.75,
            segmentMu: 0.205,
            segmentSigma: 0.007,
            gateMean: 0.217,
            gateRise: 0.028,
            verdict: 'pass',
          },
          {
            turnNumber: 5,
            messageIndex: 9,
            driftP: 0.55,
            driftPGated: 0.55,
            anchorDistance: 0.5,
            // The arriving reading clears the segment's criterion — the
            // verdict lands on arrival; the spike never reaches the slow
            // accumulator and the baseline is shredded.
            immediateThreshold: 0.258,
            immediateZ: 16.01,
            segmentMu: 0.217,
            segmentSigma: 0.021,
            fireChannel: 'immediate',
            verdict: 'fire',
          },
        ],
        divergences: [],
        anchorCounsel: [{ turnNumber: 5, anchorDistance: 0.5 }],
        emd: { pairs: [], tauMerge: null, halves: [], revisits: [] },
      },
    };
  }

  it('renders the live gate as its own chart: trigger line, drift lane and z panel', () => {
    const { html } = renderThreadReport(gateFixtureReport());
    // The report renders two charts: the offline fold's own chart, and
    // the live gate's two-panel chart (arrival drift above, z below).
    expect(html).toContain('chart-offline');
    expect(html).toContain('chart-live');
    expect(html).toContain('data-chart-block="offline"');
    expect(html).toContain('data-chart-block="live"');
    // The live trigger: per-segment state — a marker per judged Turn at
    // the criterion that judged it, tagged with its live segment (every
    // fired Turn opens the next one), and a dashed lead-in of the
    // standing default across the cold-start mute (4 judged Turns).
    expect(html).toContain('class="series-live-trigger"');
    expect(countMatches(html, /class="live-trigger-point"/g)).toBe(4);
    expect(html).toContain(
      'arrival judged against 0.350 — bootstrap: flat T_segment until the baseline holds 2 accepted members · live segment 1',
    );
    expect(html).toContain(
      'arrival judged against 0.245 — z-adjusted: μ 0.205 + 2·max(σ 0.007, σ_floor 0.02) · live segment 1',
    );
    expect(html).toContain('live segment 2');
    expect(html).toContain('class="series-live-trigger-lead"');
    expect(html).toContain('standing T_segment 0.35');
    // The old baseline clutter is gone: no allowance band, no μ baseline
    // series, no dotted criterion trail.
    expect(html).not.toContain('gate-allowance-band');
    expect(html).not.toContain('series-gate-baseline');
    expect(html).not.toContain('series-immediate-criterion');
    // The z panel: the flat segment-local trigger at z = k, the segment
    // mean at z = 0, and one marker per baseline-warm arrival (2 of 4).
    expect(html).toContain('class="z-trigger-line"');
    expect(html).toContain('fires at z ≥ k = 2');
    expect(html).toContain('segment mean μ (z 0)');
    expect(countMatches(html, /class="z-point /g)).toBe(2);
    expect(html).toContain('z 16.01 — reading 0.550 vs trigger 0.258');
    expect(html).toContain('z 1.75 — reading 0.240 vs trigger 0.245');
    // Fire turns get a translucent band + centre line (drift panel).
    expect(countMatches(html, /class="gate-fire-band"/g)).toBe(1);
    expect(html).toContain('class="gate-fire-mark"');
    // Slow-drift counsel rides the offline chart's Anchor wander series.
    expect(html).toContain('data-toggle="counsel"');
    expect(countMatches(html, /class="counsel-mark"/g)).toBe(1);
    expect(html).toContain('slow-drift counsel');
    // The verdict tooltips carry the patrol's raw-drift reading (its own
    // baseline and accumulated rise, in drift units), the criterion the
    // reading was judged against (with its z), and the fire channel.
    expect(html).toContain(
      'patrol baseline 0.205 · accumulated rise 0.005 (fires at λ 1.00, drift units)',
    );
    expect(html).toContain(
      'patrol baseline 0.217 · accumulated rise 0.028 (fires at λ 1.00, drift units)',
    );
    expect(html).toContain('criterion 0.245 (z 1.75)');
    expect(html).toContain('criterion 0.258 (z 16.01) · fired by the immediate channel');
    expect(html).toContain(
      'criterion 0.350 (bootstrap — the constant stands in until the baseline holds 2 accepted members)',
    );
    // Each chart's control row scopes to its own block.
    expect(html).toContain('data-controls="live"');
    expect(html).toContain('drift_p — arrival drift (verdict signal)');
    expect(html).toContain('Slow drift counsel marks');
  });

  it('renders legacy gate points without baseline readings gracefully', () => {
    const report = gateFixtureReport();
    if (!report.gateReplay) throw new Error('fixture carries the gate section');
    // Older reports predate the baseline/z contract: strip every audit
    // field from the points.
    report.gateReplay.points = report.gateReplay.points.map(
      ({
        gateMean: _m,
        gateRise: _r,
        immediateThreshold: _i,
        immediateZ: _z,
        segmentMu: _mu,
        segmentSigma: _sig,
        fireChannel: _f,
        ...rest
      }) => rest,
    );
    const { html } = renderThreadReport(report);
    // The live chart still renders — drift lane, fires — but without
    // judged criteria there is no trigger line, and the z panel says so.
    expect(html).toContain('chart-live');
    expect(html).toContain('class="series-prospective-drift"');
    expect(html).not.toContain('class="series-live-trigger"');
    expect(html).not.toContain('class="live-trigger-point"');
    expect(html).toContain('class="z-empty-note"');
    expect(html).not.toContain('class="z-point"');
  });

  it('renders without chart or segment data instead of crashing', () => {
    const empty: ThreadReport = {
      ...fixtureReport(),
      costProfile: [],
      driftSeries: [],
      segments: [],
    };
    const rendered: RenderedThreadReport = renderThreadReport(empty);
    expect(rendered.html).not.toMatch(/<svg[ >]/);
    expect(rendered.html).toContain('No chart data');
    expect(rendered.html).toContain('No topic segments');
    expect(JSON.parse(rendered.json)).toEqual(empty);
  });
});

async function findThreadSnapshot(threadId: string) {
  const thread = await findThreadByIdAndUser({ userId: USER_ID, threadId });
  if (!thread) throw new Error('expected thread');
  return { id: thread.id, userId: thread.userId, title: thread.title, createdAt: thread.createdAt };
}
