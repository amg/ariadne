import { listMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/listMessageEmbeddingsByMessageIds';
import { getExpansionCostByMessageId } from '@queries/messageExpansionCosts/getExpansionCostByMessageId';
import { getMessageUsageByMessageId } from '@queries/messageUsage/getMessageUsageByMessageId';
import { insertMessage } from '@queries/messages/insertMessage';
import { listSegmentDriftLogsByThread } from '@queries/segmentDriftLogs/listSegmentDriftLogsByThread';
import { listThreadSegmentsByThread } from '@queries/threadSegments/listThreadSegmentsByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { editMessage, getMessages } from '@services/messageService';
import { buildLiveAnalysisView, runLiveGate } from '@services/threadAnalysis';
import { DEFAULT_USER_ID } from '@services/userService';
import { useTestDb } from '@test/test-db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type MockInferenceServer,
  buildMockEmbedding,
  startMockInferenceServer,
} from '../../mock/inferenceServer';

/**
 * Real e2e of the LIVE lane against the built-in mock inference server:
 * the fill-forward walk, its persisted chain, the never-re-embed
 * guarantee, retry recovery, and the invalidation an edit triggers. The
 * mock embedder is deterministic and content-seeded — every distinct text
 * embeds to an almost-orthogonal vector, so each topic pivot fires the
 * gate; that chain is recomputed by the mirror below and asserted
 * exactly, never predicted by hand.
 */

// Self-contained prompts well past the 120-char expansion trigger — both
// `needsRewriteHeuristic` and the `shortEnough` backstop return false for
// them, so every arrival rides the raw fast path: its only provider call is
// one arrival embed, and the rewrite/judge cost columns stay null. That
// makes the walk's per-arrival request accounting exact.
const PAD =
  ' consider every practical detail carefully before you answer this, accounting for common edge' +
  ' cases, and explain your reasoning step by step so a beginner can follow along clearly';

type TurnSpec = { user: string; assistant?: string };

function topic(user: string, assistant: string): TurnSpec {
  return { user: `${user}${PAD}`, assistant: `${assistant}${PAD}` };
}

const TOPIC_SPECS: TurnSpec[] = [
  topic(
    'please explain how to keep a sourdough starter healthy',
    'Hydration and timing keep the culture active.',
  ),
  topic('describe how a jet turbine compresses intake air', 'Axial stages step the pressure up.'),
  topic(
    'outline what keeps a sailboat balanced under sail',
    'Ballast low and sails trimmed upright.',
  ),
  topic('walk me through brewing espresso at home', 'Fresh beans, fine grind, short pull.'),
  topic('return to sourdough and explain scoring the loaf', 'Deep cuts guide the oven spring.'),
];

// The analyzer operates under the single-user placeholder (like every route).
const USER_ID = DEFAULT_USER_ID;

// ── The deterministic mirror ──────────────────────────────────────────────

/** Judgment parameters shared with the gate (DEFAULT_ANALYZE_OPTIONS). */
const PARAMS = {
  segmentThreshold: 0.52,
  immediateK: 2,
  sigmaFloor: 0.02,
  minSamples: 3,
  delta: 0,
  lambda: 0.5,
} as const;

/** pgvector stores float4 — simulate the round-trip like the rows do. */
function toFloat4(vector: number[]): number[] {
  return vector.map((value) => Math.fround(value));
}

function prospectiveText(user: string): string {
  return `User:\n${user}\n\n`;
}

function turnBlock(user: string, assistant: string): string {
  return `User:\n${user}\n\nAssistant:\n${assistant}\n\n`;
}

/** Folder-private cosine distance, mirrored (drift.ts). */
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

function unitVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

interface MirrorState {
  baselineCount: number;
  baselineMean: number;
  baselineM2: number;
  phCount: number;
  phSum: number;
  phCumulative: number;
  phLowWater: number;
}

function freshMirror(): MirrorState {
  return {
    baselineCount: 0,
    baselineMean: 0,
    baselineM2: 0,
    phCount: 0,
    phSum: 0,
    phCumulative: 0,
    phLowWater: 0,
  };
}

function resetLedger(state: MirrorState) {
  state.baselineCount = 0;
  state.baselineMean = 0;
  state.baselineM2 = 0;
}

function resetPatrol(state: MirrorState) {
  state.phCount = 0;
  state.phSum = 0;
  state.phCumulative = 0;
  state.phLowWater = 0;
}

/**
 * Mirror of the shared two-channel judge (verdict.ts), private internals
 * reimplemented for test independence. Returns the channel that fired and
 * the baseline snapshot at judgment — the exact shape the drift log stores.
 */
function mirrorJudge(
  state: MirrorState,
  reading: number,
): { fire: 'immediate' | 'slow' | null; mu: number | null; sigma: number | null } {
  const mu = state.baselineCount === 0 ? null : state.baselineMean;
  const sigma =
    state.baselineCount < 2 ? null : Math.sqrt(state.baselineM2 / (state.baselineCount - 1));
  const baselineWarm = mu !== null && sigma !== null && state.baselineCount >= 2;
  const threshold = baselineWarm
    ? mu + PARAMS.immediateK * Math.max(sigma, PARAMS.sigmaFloor)
    : PARAMS.segmentThreshold;

  if (reading >= threshold) {
    resetLedger(state);
    resetPatrol(state);
    return { fire: 'immediate', mu, sigma };
  }

  state.phCount += 1;
  state.phSum += reading;
  const mean = state.phSum / state.phCount;
  state.phCumulative += reading - mean - PARAMS.delta;
  if (state.phCumulative < state.phLowWater) state.phLowWater = state.phCumulative;
  const slowFired =
    state.phCount >= PARAMS.minSamples && state.phCumulative - state.phLowWater >= PARAMS.lambda;
  if (slowFired) {
    resetLedger(state);
    resetPatrol(state);
    return { fire: 'slow', mu, sigma };
  }

  // Accepted: fold into the segment baseline (Welford).
  state.baselineCount += 1;
  const delta = reading - state.baselineMean;
  state.baselineMean += delta / state.baselineCount;
  state.baselineM2 += delta * (reading - state.baselineMean);
  return { fire: null, mu, sigma };
}

interface ExpectedArrival {
  verdict: 'muted' | 'pass' | 'fire';
  fireChannel: 'immediate' | 'slow' | null;
  slowDriftStartMessageId: string | null;
  driftP: number | null;
  mu: number | null;
  sigma: number | null;
  /** The user Message that starts the segment this arrival was judged in. */
  segmentStartIndex: number;
}

type ArrivalJudgment = Pick<ExpectedArrival, 'verdict' | 'fireChannel' | 'driftP' | 'mu' | 'sigma'>;

/**
 * One arrival's mirror verdict: mute while there is nothing to compare,
 * otherwise judge the reading through the two-channel mirror.
 */
function mirrorArrival(
  state: MirrorState,
  reading: number | null,
  completedTurns: number,
): ArrivalJudgment {
  if (reading === null || completedTurns < 1) {
    return { verdict: 'muted', fireChannel: null, driftP: null, mu: null, sigma: null };
  }
  const judged = mirrorJudge(state, reading);
  return {
    verdict: judged.fire === null ? 'pass' : 'fire',
    fireChannel: judged.fire,
    driftP: reading,
    mu: judged.mu,
    sigma: judged.sigma,
  };
}

/** Fold a completed Turn into the segment's running sum (reseed on fire). */
function foldTurnVector(
  memberSum: number[] | null,
  foldedVector: number[],
  reseed: boolean,
): number[] {
  return reseed || memberSum === null
    ? [...foldedVector]
    : memberSum.map((value, index) => value + (foldedVector[index] ?? 0));
}

/**
 * The verdict chain the walk must persist for `specs`, recomputed through
 * the same sequence the gate runs: judge against the Gravity point the
 * segment carries into the arrival, shred + reseed on a fire, fold the
 * completed Turn afterwards.
 */
function expectedChain(specs: TurnSpec[]): ExpectedArrival[] {
  const state = freshMirror();
  let memberSum: number[] | null = null;
  let completedTurns = 0;
  let segmentStartIndex = 0;
  const arrived: ExpectedArrival[] = [];

  for (const specRow of specs) {
    if (specRow.assistant === undefined) throw new Error('mirror expects complete turns');
    const reading =
      memberSum === null
        ? null
        : cosineDistance(
            toFloat4(buildMockEmbedding(prospectiveText(specRow.user))),
            unitVector(memberSum),
          );
    const judged = mirrorArrival(state, reading, completedTurns);
    arrived.push({ ...judged, segmentStartIndex, slowDriftStartMessageId: null });
    if (judged.verdict === 'fire') segmentStartIndex = arrived.length - 1;
    const foldedVector = toFloat4(buildMockEmbedding(turnBlock(specRow.user, specRow.assistant)));
    memberSum = foldTurnVector(memberSum, foldedVector, judged.verdict === 'fire');
    completedTurns += 1;
  }

  return arrived;
}

// ── Seeding + assertions ──────────────────────────────────────────────────

async function seedThread(title: string, specs: TurnSpec[]) {
  await insertUserIfNotExists({ id: USER_ID });
  const thread = await insertThread({ userId: USER_ID, title });
  const userMessageIds: string[] = [];
  const assistantMessageIds: string[] = [];
  for (const specRow of specs) {
    const userMessage = await insertMessage({
      threadId: thread.id,
      role: 'user',
      content: specRow.user,
    });
    userMessageIds.push(userMessage.id);
    if (specRow.assistant === undefined) continue;
    const assistantMessage = await insertMessage({
      threadId: thread.id,
      role: 'assistant',
      content: specRow.assistant,
    });
    assistantMessageIds.push(assistantMessage.id);
  }
  return { threadId: thread.id, userMessageIds, assistantMessageIds };
}

function assertSuccess(result: Awaited<ReturnType<typeof runLiveGate>>) {
  expect(result.type).toBe('success');
  if (result.type !== 'success') throw new Error('expected success');
  return result.data;
}

function assertError(result: Awaited<ReturnType<typeof runLiveGate>>) {
  expect(result.type).toBe('error');
  if (result.type !== 'error') throw new Error('expected error');
  return result;
}

async function readChain(threadId: string) {
  const [segments, logs] = await Promise.all([
    listThreadSegmentsByThread({ threadId, modelId: EMBEDDING_MODEL_ID }),
    listSegmentDriftLogsByThread({ threadId, modelId: EMBEDDING_MODEL_ID }),
  ]);
  return { segments, logs };
}

/**
 * Runs `fn` with no provider configured — '' reads as unset by @config/env
 * — restoring the saved state afterward without `delete`.
 */
async function withProviderUnconfigured<T>(fn: () => Promise<T>): Promise<T> {
  const savedUrl = process.env.MOCK_AI_BASE_URL;
  const savedKey = process.env.DEEPINFRA_API_KEY;
  process.env.MOCK_AI_BASE_URL = '';
  process.env.DEEPINFRA_API_KEY = '';
  try {
    return await fn();
  } finally {
    process.env.MOCK_AI_BASE_URL = savedUrl ?? '';
    process.env.DEEPINFRA_API_KEY = savedKey ?? '';
  }
}

/** Runs `fn` with the feature flag off, restoring the flag afterward. */
async function withAnalysisOff<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.THREAD_ANALYSIS_MODE;
  process.env.THREAD_ANALYSIS_MODE = 'off';
  try {
    return await fn();
  } finally {
    if (saved === undefined) process.env.THREAD_ANALYSIS_MODE = 'heuristic';
    else process.env.THREAD_ANALYSIS_MODE = saved;
  }
}

// ── The suite ─────────────────────────────────────────────────────────────

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
  process.env.MOCK_AI_BASE_URL = savedMockUrl ?? '';
  process.env.DEEPINFRA_API_KEY = savedApiKey ?? '';
  await mock.stop();
});

describe('runLiveGate — the fill-forward walk', () => {
  it('persists one verdict row per arrival and the segments the fires burned', async () => {
    const { threadId, userMessageIds } = await seedThread('live chain', TOPIC_SPECS);
    const expected = expectedChain(TOPIC_SPECS);

    const lastExpected = expected[expected.length - 1];
    const outcome = assertSuccess(await runLiveGate({ threadId }));
    expect(outcome).toEqual({
      verdict: lastExpected?.verdict ?? null,
      fireChannel: lastExpected?.fireChannel ?? null,
      slowDriftStartMessageId: lastExpected?.slowDriftStartMessageId ?? null,
      messageId: userMessageIds[userMessageIds.length - 1] ?? null,
    });

    const { segments, logs } = await readChain(threadId);
    expect(logs).toHaveLength(TOPIC_SPECS.length);

    // The mirror's chain, row for row: verdict, channel, and the judged
    // numbers, against the segment each arrival was judged in. For
    // hash-random topic pivots the baseline never accepts twice, so every
    // judged arrival bootstraps on the flat T_segment (mu/sigma stay null).
    for (let index = 0; index < logs.length; index += 1) {
      const log = logs[index];
      const exp = expected[index];
      expect(log).toBeDefined();
      expect(exp).toBeDefined();
      if (!log || !exp) throw new Error('walk/index misalignment');
      expect(log.messageId).toBe(userMessageIds[index]);
      expect(log.verdict).toBe(exp.verdict);
      expect(log.fireChannel).toBe(exp.fireChannel);
      if (exp.driftP === null) {
        expect(log.driftP).toBeNull();
      } else {
        expect(log.driftP).toBeCloseTo(exp.driftP, 4);
      }
      expect(log.mu).toBeNull();
      expect(log.sigma).toBeNull();
      expect(log.segmentStartMessageId).toBe(userMessageIds[exp.segmentStartIndex ?? 0]);
    }

    // One segment opens on arrival one; each fire burns another right
    // under itself.
    const expectedSegStarts = TOPIC_SPECS.map((_, index) => index).filter(
      (index) => index === 0 || expected[index]?.verdict === 'fire',
    );
    expect(segments.map((segment) => segment.startMessageId)).toEqual(
      expectedSegStarts.map((index) => userMessageIds[index]),
    );
  });

  it('keeps one clean chain when two walks overlap', async () => {
    const { threadId, userMessageIds } = await seedThread('overlapping walks', TOPIC_SPECS);
    const thirdArrival = userMessageIds[2];
    if (!thirdArrival) throw new Error('seed too short');

    // The two surfaces that drive the walk at once: an exchange judges up
    // to its own arrival while the analysis backfill walks the whole
    // thread. Both fire from stale snapshots of the chain — only one walk
    // may write it.
    const [exchange, backfill] = await Promise.all([
      runLiveGate({ threadId, upToMessageId: thirdArrival }),
      runLiveGate({ threadId }),
    ]);
    assertSuccess(exchange);
    assertSuccess(backfill);

    const { logs, segments } = await readChain(threadId);
    // One row per arrival — the duplication this defends against.
    expect(new Set(logs.map((log) => log.messageId)).size).toBe(logs.length);
    expect(logs.map((log) => log.messageId)).toEqual(userMessageIds);

    // The chain and its judgments are the single walk's either way.
    const expected = expectedChain(TOPIC_SPECS);
    for (let index = 0; index < logs.length; index += 1) {
      const log = logs[index];
      const exp = expected[index];
      if (!log || !exp) throw new Error('walk/index misalignment');
      expect(log.verdict).toBe(exp.verdict);
      expect(log.segmentStartMessageId).toBe(userMessageIds[exp.segmentStartIndex ?? 0]);
    }
    const expectedSegStarts = TOPIC_SPECS.map((_, index) => index).filter(
      (index) => index === 0 || expected[index]?.verdict === 'fire',
    );
    expect(segments.map((segment) => segment.startMessageId)).toEqual(
      expectedSegStarts.map((index) => userMessageIds[index]),
    );
  });

  it('keys arrival rows to user Messages; embedding spend rides the arrival row', async () => {
    const { threadId, userMessageIds, assistantMessageIds } = await seedThread(
      'agents and cost',
      TOPIC_SPECS,
    );
    assertSuccess(await runLiveGate({ threadId }));

    const stored = await listMessageEmbeddingsByMessageIds({
      messageIds: [...userMessageIds, ...assistantMessageIds],
    });
    const byMessage = new Map(stored.map((row) => [row.messageId, row]));
    expect(byMessage.size).toBe(userMessageIds.length + assistantMessageIds.length);

    for (const messageId of userMessageIds) {
      const row = byMessage.get(messageId);
      expect(row?.modelId).toBe(EMBEDDING_MODEL_ID);
      // Raw fast paths: the raw message itself was embedded (no rewrite
      // text) and neither the judge nor the rewriter billed anything —
      // only the embedding step spends, and its cost rides the arrival row.
      expect(row?.rewrittenText).toBeNull();
      expect(Number(row?.embeddingCostUsd)).toBeGreaterThan(0);
      expect(await getExpansionCostByMessageId({ messageId, kind: 'rewrite' })).toBeUndefined();
      expect(await getExpansionCostByMessageId({ messageId, kind: 'judge' })).toBeUndefined();
    }
    for (const messageId of assistantMessageIds) {
      expect(byMessage.get(messageId)?.modelId).toBe(EMBEDDING_MODEL_ID);
    }
    for (const messageId of assistantMessageIds) {
      // The live lane bills no chat inference; turn rows never carry one.
      expect(await getMessageUsageByMessageId({ messageId })).toBeUndefined();
    }
  });

  it('never re-embeds or re-logs on replay — the chain is the truth', async () => {
    const { threadId } = await seedThread('replay', TOPIC_SPECS);
    const before = mock.embeddings.requestCount();
    assertSuccess(await runLiveGate({ threadId }));
    const afterFirst = mock.embeddings.requestCount();
    // One arrival embed plus one completed-Turn embed per arrival.
    expect(afterFirst - before).toBe(TOPIC_SPECS.length * 2);

    const { logs, segments } = await readChain(threadId);
    assertSuccess(await runLiveGate({ threadId }));
    expect(mock.embeddings.requestCount()).toBe(afterFirst);

    const replayed = await readChain(threadId);
    expect(replayed.logs.map((log) => log.id)).toEqual(logs.map((log) => log.id));
    expect(replayed.segments.map((segment) => segment.id)).toEqual(
      segments.map((segment) => segment.id),
    );
  });

  it('fills forward to a target arrival, then backfills the remainder', async () => {
    const { threadId, userMessageIds } = await seedThread('fill forward', TOPIC_SPECS);
    const secondArrival = userMessageIds[1];
    if (!secondArrival) throw new Error('seed too short');

    assertSuccess(await runLiveGate({ threadId, upToMessageId: secondArrival }));
    const partial = await readChain(threadId);
    expect(partial.logs.map((log) => log.messageId)).toEqual(userMessageIds.slice(0, 2));

    assertSuccess(await runLiveGate({ threadId }));
    const full = await readChain(threadId);
    expect(full.logs.map((log) => log.messageId)).toEqual(userMessageIds);
    // The partial rows kept their identities across the backfill.
    expect(full.logs.slice(0, 2).map((log) => log.id)).toEqual(partial.logs.map((log) => log.id));
  });

  it('rejects a target the walk does not own', async () => {
    const { threadId, assistantMessageIds } = await seedThread('bad target', TOPIC_SPECS);
    const firstAssistant = assistantMessageIds[0];
    if (!firstAssistant) throw new Error('seed too short');
    // Turn rows are not arrivals: the walk cannot judge toward one.
    expect(assertError(await runLiveGate({ threadId, upToMessageId: firstAssistant })).code).toBe(
      'thread_not_found',
    );
  });

  it('returns the empty outcome for threads with no arrivals', async () => {
    const empty = await seedThread('empty', []);
    const unanswered = await seedThread('user only', [{ user: `a question with no reply${PAD}` }]);
    expect(assertSuccess(await runLiveGate({ threadId: empty.threadId }))).toEqual({
      verdict: null,
      slowDriftStartMessageId: null,
      fireChannel: null,
      messageId: null,
    });
    // A user-only thread owns exactly one arrival — judged from scratch,
    // muted against an empty segment, and never folded into anything.
    const single = assertSuccess(await runLiveGate({ threadId: unanswered.threadId }));
    expect(single.verdict).toBe('muted');
    expect(single.messageId).toBe(unanswered.userMessageIds[0]);
    const stored = await listMessageEmbeddingsByMessageIds({
      messageIds: unanswered.userMessageIds,
    });
    expect(stored).toHaveLength(1);
  });
});

describe('runLiveGate — failure is a failed exchange, progress survives', () => {
  it('fails the pipeline on an embed failure and keeps what already persisted', async () => {
    const { threadId, userMessageIds } = await seedThread('abort and resume', TOPIC_SPECS);
    // arrival 1 (req +1) + turn 1 fold (req +2) land; arrival 2's embed
    // (req +3) fails — the walk reports the failure with arrival 1 kept.
    mock.embeddings.failFrom(mock.embeddings.requestCount() + 3);
    expect(assertError(await runLiveGate({ threadId })).code).toBe('embed_failed');

    const { logs, segments } = await readChain(threadId);
    expect(logs.map((log) => log.messageId)).toEqual([userMessageIds[0]]);
    expect(segments).toHaveLength(1);
  });

  it('resumes from the first missing signal after the provider recovers', async () => {
    const { threadId, userMessageIds } = await seedThread('resume', TOPIC_SPECS);
    mock.embeddings.failFrom(mock.embeddings.requestCount() + 3);
    assertError(await runLiveGate({ threadId }));
    mock.embeddings.clearFailures();

    const beforeResume = mock.embeddings.requestCount();
    assertSuccess(await runLiveGate({ threadId }));
    // The injected failure landed on arrival 2's embed, so arrival 1's
    // embed and turn 1's fold both already persisted on the failed run.
    // Resume re-embeds only the missing arrivals 2..5 plus folds 2..5:
    // `turns*2 − 2` new calls, no earlier embedding ever repeated.
    expect(mock.embeddings.requestCount() - beforeResume).toBe(TOPIC_SPECS.length * 2 - 2);

    const { logs } = await readChain(threadId);
    expect(logs.map((log) => log.messageId)).toEqual(userMessageIds);
  });

  it('reports provider_not_configured when nothing is wired', async () => {
    const { threadId } = await seedThread('unconfigured', TOPIC_SPECS);
    const outcome = await withProviderUnconfigured(() => runLiveGate({ threadId }));
    expect(assertError(outcome).code).toBe('provider_not_configured');
  });

  it('writes through the off switch: no pipeline, no rows, no failures', async () => {
    const { threadId } = await seedThread('off switch', TOPIC_SPECS);
    const outcome = await withAnalysisOff(() => runLiveGate({ threadId }));
    expect(outcome).toEqual({
      type: 'success',
      data: { verdict: null, slowDriftStartMessageId: null, fireChannel: null, messageId: null },
    });
    const { logs, segments } = await readChain(threadId);
    expect(logs).toHaveLength(0);
    expect(segments).toHaveLength(0);
  });
});

describe('edit forks — the abandoned arrival keeps its chain', () => {
  it('an edit abandons its arrival intact; the refill judges the forked arrival', async () => {
    const { threadId, userMessageIds } = await seedThread('edit chain', TOPIC_SPECS);
    assertSuccess(await runLiveGate({ threadId }));
    const lastUser = userMessageIds[userMessageIds.length - 1];
    if (!lastUser) throw new Error('seed too short');
    const originalContent = TOPIC_SPECS[TOPIC_SPECS.length - 1]?.user ?? '';

    // The edit forks: the arrival is abandoned, never rewritten.
    const editedContent = `${originalContent} — revised${PAD}`;
    const edit = await editMessage({
      userId: USER_ID,
      threadId,
      messageId: lastUser,
      content: editedContent,
    });
    expect(edit.type).toBe('success');
    if (edit.type !== 'success') throw new Error('expected success');
    const forkedId = edit.data.id;
    expect(forkedId).not.toBe(lastUser);

    // The abandoned arrival keeps every chain row — its reading was never
    // touched, so its analysis is still correct for it.
    const { logs: logsAfterEdit, segments: segmentsAfterEdit } = await readChain(threadId);
    expect(logsAfterEdit.map((log) => log.messageId)).toEqual(userMessageIds);
    expect(segmentsAfterEdit.map((segment) => segment.startMessageId)).toContain(lastUser);
    const storedAfterEdit = await listMessageEmbeddingsByMessageIds({
      messageIds: userMessageIds,
    });
    expect(new Set(storedAfterEdit.map((row) => row.messageId))).toEqual(new Set(userMessageIds));
    // The forked arrival is not judged yet — it waits for the next pass.
    expect(await listMessageEmbeddingsByMessageIds({ messageIds: [forkedId] })).toEqual([]);

    // Reply again and the refill judges the forked arrival end-to-end.
    await insertMessage({ threadId, role: 'assistant', content: `revised reply${PAD}` });
    assertSuccess(await runLiveGate({ threadId }));
    const { logs: logsAfterRefill } = await readChain(threadId);
    expect(logsAfterRefill.map((log) => log.messageId)).toEqual([...userMessageIds, forkedId]);
    const forkedRows = await listMessageEmbeddingsByMessageIds({ messageIds: [forkedId] });
    expect(forkedRows).toHaveLength(1);

    const messages = await getMessages({ userId: USER_ID, threadId });
    // The old text stays with its arrival; the forked row carries the edit.
    expect(messages?.find((message) => message.id === lastUser)?.content).toBe(originalContent);
    expect(messages?.find((message) => message.id === forkedId)?.content).toBe(editedContent);

    // The live reading drops the abandoned arrival but keeps the forked one:
    // the topic story follows the live conversation, not the debris.
    const view = await buildLiveAnalysisView(threadId);
    expect(view.type).toBe('success');
    if (view.type !== 'success') throw new Error('expected success');
    const pointIds = view.data.points.map((point) => point.messageId);
    expect(pointIds).not.toContain(lastUser);
    expect(pointIds).toContain(forkedId);
    expect(view.data.pending).toBe(false);
  });
});

describe('the analysis surface reads the persisted chain', () => {
  it('marks the view pending while arrivals outrun the logs, clear when whole', async () => {
    const { threadId, userMessageIds } = await seedThread('view', TOPIC_SPECS);
    const secondArrival = userMessageIds[1];
    if (!secondArrival) throw new Error('seed too short');

    const unfilled = await buildLiveAnalysisView(threadId);
    expect(unfilled.type).toBe('success');
    if (unfilled.type !== 'success') throw new Error('expected success');
    expect(unfilled.data.pending).toBe(true);
    expect(unfilled.data.points).toHaveLength(0);

    assertSuccess(await runLiveGate({ threadId, upToMessageId: secondArrival }));
    const partial = await buildLiveAnalysisView(threadId);
    if (partial.type !== 'success') throw new Error('expected success');
    expect(partial.data.pending).toBe(true);
    expect(partial.data.points.map((point) => point.messageId)).toEqual(userMessageIds.slice(0, 2));

    assertSuccess(await runLiveGate({ threadId }));
    const full = await buildLiveAnalysisView(threadId);
    if (full.type !== 'success') throw new Error('expected success');
    expect(full.data.pending).toBe(false);
    expect(full.data.points).toHaveLength(TOPIC_SPECS.length);
    // Every point remembers its arrival position and where its segment starts.
    const startTurnBySegment = new Map(
      full.data.segments.map((segment) => {
        const opening = full.data.points.find(
          (point) => point.messageId === segment.startMessageId,
        );
        return [segment.segmentId, opening?.turnNumber ?? 0];
      }),
    );
    expect(full.data.points.map((point) => point.turnNumber)).toEqual([1, 2, 3, 4, 5]);
    for (const segment of full.data.segments) {
      expect(startTurnBySegment.get(segment.segmentId)).toBeGreaterThan(0);
    }
  });

  it('carries the fire semantics onto the segment table', async () => {
    const { threadId } = await seedThread('segment table', TOPIC_SPECS);
    assertSuccess(await runLiveGate({ threadId }));
    const view = await buildLiveAnalysisView(threadId);
    if (view.type !== 'success') throw new Error('expected success');
    // Every pivot fires in this corpus: each segment ends in a flame.
    expect(view.data.points.filter((point) => point.verdict === 'fire').length).toBe(
      TOPIC_SPECS.length - 1,
    );
    expect(view.data.segments.length).toBe(view.data.points.length);
    expect(view.data.segments[view.data.segments.length - 1]?.closedByChannel).toBe(null);
  });

  it('lists a boundary arrival under the segment it opens, not the one it burned', async () => {
    const { threadId } = await seedThread('boundary attribution', TOPIC_SPECS);
    assertSuccess(await runLiveGate({ threadId }));
    const view = await buildLiveAnalysisView(threadId);
    if (view.type !== 'success') throw new Error('expected success');

    // Membership follows the segment span: the Boundary turn closes the
    // current Topic segment and seeds the next, so the fired arrival
    // belongs to the segment it opens — the one whose start Message it
    // is. The drift log keeps the judged-in segment; that is the previous
    // baseline's story, not the membership one.
    for (const segment of view.data.segments) {
      const opening = view.data.points.find((point) => point.messageId === segment.startMessageId);
      expect(opening).toBeDefined();
      expect(opening?.segmentIndex).toBe(segment.index);
    }
    // Every pivot fires in this corpus, so arrival i opens segment i.
    expect(view.data.points.map((point) => point.segmentIndex)).toEqual([1, 2, 3, 4, 5]);
    expect(view.data.segments.map((segment) => segment.arrivalCount)).toEqual([1, 1, 1, 1, 1]);

    // The store is untouched: the log still names the segment that judged
    // the fired arrival — the burned segment's start Message, not the
    // fired arrival itself.
    const { logs } = await readChain(threadId);
    const firedLog = logs.find((log) => log.verdict === 'fire');
    expect(firedLog?.segmentStartMessageId).not.toBe(
      view.data.points.find((point) => point.verdict === 'fire')?.messageId,
    );
  });

  it('the off switch erases the view without touching the store', async () => {
    const { threadId } = await seedThread('off view', TOPIC_SPECS);
    assertSuccess(await runLiveGate({ threadId }));
    const { logs: logsBefore } = await readChain(threadId);
    expect(logsBefore.length).toBeGreaterThan(0);

    const offView = await withAnalysisOff(() => buildLiveAnalysisView(threadId));
    if (offView.type !== 'success') throw new Error('expected success');
    expect(offView.data.mode).toBe('off');
    expect(offView.data.points).toHaveLength(0);
    expect(offView.data.segments).toHaveLength(0);
    expect(offView.data.pending).toBe(false);

    const { logs: logsAfter } = await readChain(threadId);
    expect(logsAfter.map((log) => log.id)).toEqual(logsBefore.map((log) => log.id));
  });

  it('getMessages attaches the live verdict to user arrivals only', async () => {
    const { threadId, userMessageIds, assistantMessageIds } = await seedThread(
      'colors',
      TOPIC_SPECS,
    );
    assertSuccess(await runLiveGate({ threadId }));

    const messages = await getMessages({ userId: USER_ID, threadId });
    const userRows = TOPIC_SPECS.map((_, index) => ({
      expectedId: userMessageIds[index],
      row: messages?.find((message) => message.id === userMessageIds[index]),
    }));
    expect(userRows[0]?.row?.driftVerdict).toEqual({ verdict: 'muted', fireChannel: null });
    for (const { row } of userRows.slice(1)) {
      expect(row?.driftVerdict).toEqual({ verdict: 'fire', fireChannel: 'immediate' });
    }
    for (const id of assistantMessageIds) {
      expect(messages?.find((message) => message.id === id)?.driftVerdict).toBeNull();
    }

    // Off: the bubbles go plain while the store keeps its signals.
    const offMessages = await withAnalysisOff(() => getMessages({ userId: USER_ID, threadId }));
    for (const id of userMessageIds) {
      expect(offMessages?.find((message) => message.id === id)?.driftVerdict).toBeNull();
    }
  });
});
