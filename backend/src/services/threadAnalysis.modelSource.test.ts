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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';

/**
 * One live chain per embedding model. The mock embedder is content-seeded
 * and ignores the model name, so a model change re-judges to the SAME
 * numbers on fresher provenance: the suite flips the model id mid-run and
 * asserts a fresh parallel chain builds, the retired one survives intact,
 * the surfaces read only the current chain, and an edit invalidates every
 * model's signals.
 */

// The mock always serves the primary id; the override target carries the
// provenance the whole suite flips.
const PRIMARY = EMBEDDING_MODEL_ID;
const SECONDARY = 'BAAI/bge-small-en-v1.5';

// The provenance bearer is a code constant behind the ai-service boundary;
// the suite flips it through a live getter on the config module's export —
// every importer, direct or re-exported, reads the flip.
const modelState = vi.hoisted(() => ({ current: '', primary: '' }));

vi.mock('@services/aiService/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/aiService/config')>();
  modelState.primary = actual.EMBEDDING_MODEL_ID;
  return Object.defineProperty({ ...actual }, 'EMBEDDING_MODEL_ID', {
    get: () => modelState.current || modelState.primary,
    enumerable: true,
  });
});

// Self-contained prompts past the expansion trigger: every arrival rides
// the raw fast path, so the walk's only provider work is embedding.
const PAD =
  ' consider every practical detail carefully before you answer this, accounting for common edge' +
  ' cases, and explain your reasoning step by step so a beginner can follow along clearly';

type TurnSpec = { user: string; assistant: string };

function topic(user: string, assistant: string): TurnSpec {
  return { user: `${user}${PAD}`, assistant: `${assistant}${PAD}` };
}

// Three almost-orthogonal pivots: arrival one mutes, the other two fire —
// the same three-segment chain under either model.
const TOPIC_SPECS: TurnSpec[] = [
  topic(
    'please explain how to keep a sourdough starter healthy',
    'Hydration and timing keep the culture active.',
  ),
  topic('describe how a jet turbine compresses intake air', 'Axial stages step the pressure up.'),
  topic('walk me through brewing espresso at home', 'Fresh beans, fine grind, short pull.'),
];

const USER_ID = DEFAULT_USER_ID;

async function seedThread(title: string, specs: TurnSpec[]) {
  await insertUserIfNotExists({ id: USER_ID });
  const thread = await insertThread({ userId: USER_ID, title });
  const userMessageIds: string[] = [];
  for (const specRow of specs) {
    const userMessage = await insertMessage({
      threadId: thread.id,
      role: 'user',
      content: specRow.user,
    });
    userMessageIds.push(userMessage.id);
    await insertMessage({ threadId: thread.id, role: 'assistant', content: specRow.assistant });
  }
  return { threadId: thread.id, userMessageIds };
}

/** One model's chain exactly as the store holds it. */
async function readChain(threadId: string, modelId: string) {
  const [segments, logs] = await Promise.all([
    listThreadSegmentsByThread({ threadId, modelId }),
    listSegmentDriftLogsByThread({ threadId, modelId }),
  ]);
  return { segments, logs };
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
  modelState.current = PRIMARY;
});

afterAll(async () => {
  process.env.MOCK_AI_BASE_URL = savedMockUrl ?? '';
  process.env.DEEPINFRA_API_KEY = savedApiKey ?? '';
  await mock.stop();
});

describe('the live chain runs one per embedding model', () => {
  it('a model change starts a parallel chain; the retired one survives intact', async () => {
    const { threadId, userMessageIds } = await seedThread('model change', TOPIC_SPECS);

    modelState.current = PRIMARY;
    const first = await runLiveGate({ threadId });
    expect(first.type).toBe('success');
    const chainA = await readChain(threadId, PRIMARY);
    expect(chainA.logs.map((log) => log.messageId)).toEqual(userMessageIds);
    expect(chainA.logs.length).toBe(TOPIC_SPECS.length);
    expect(chainA.segments.length).toBe(TOPIC_SPECS.length);

    modelState.current = SECONDARY;
    const second = await runLiveGate({ threadId });
    expect(second.type).toBe('success');
    const chainB = await readChain(threadId, SECONDARY);

    // The chain rebuilt on the new geometry: identical verdicts (the mock
    // embedder ignores the model name), one row per arrival, and its own
    // segment rows over the same openings.
    expect(chainB.logs.map((log) => log.messageId)).toEqual(userMessageIds);
    for (let index = 0; index < TOPIC_SPECS.length; index += 1) {
      const a = chainA.logs[index];
      const b = chainB.logs[index];
      if (!a || !b) throw new Error('chain/index misalignment');
      expect(b.verdict).toBe(a.verdict);
      expect(b.fireChannel).toBe(a.fireChannel);
      if (a.driftP === null) expect(b.driftP).toBeNull();
      else expect(b.driftP).toBeCloseTo(a.driftP, 6);
      expect(b.modelId).toBe(SECONDARY);
    }
    expect(chainB.segments.map((segment) => segment.startMessageId)).toEqual(
      chainA.segments.map((segment) => segment.startMessageId),
    );
    expect(chainB.segments[0]?.modelId).toBe(SECONDARY);

    // The retired chain is untouched, row for row.
    const chainAfter = await readChain(threadId, PRIMARY);
    expect(chainAfter.logs.map((log) => log.id)).toEqual(chainA.logs.map((log) => log.id));
    expect(chainAfter.segments.map((segment) => segment.id)).toEqual(
      chainA.segments.map((segment) => segment.id),
    );
  });

  it('the surfaces read only the current model chain', async () => {
    const { threadId, userMessageIds } = await seedThread('surfaces', TOPIC_SPECS);

    modelState.current = PRIMARY;
    const seeded = await runLiveGate({ threadId });
    expect(seeded.type).toBe('success');
    modelState.current = SECONDARY;
    const rebuilt = await runLiveGate({ threadId });
    expect(rebuilt.type).toBe('success');

    const view = await buildLiveAnalysisView(threadId);
    if (view.type !== 'success') throw new Error('expected success');
    // The rebuilt chain alone — no second model's rows bleed in.
    expect(view.data.pending).toBe(false);
    expect(view.data.points.map((point) => point.messageId)).toEqual(userMessageIds);
    expect(view.data.segments.length).toBe(TOPIC_SPECS.length);

    const messages = await getMessages({ userId: USER_ID, threadId });
    const bubbleOf = (messageId: string) =>
      messages?.find((message) => message.id === messageId)?.driftVerdict;
    expect(bubbleOf(userMessageIds[0] as string)?.verdict).toBe('muted');
    expect(bubbleOf(userMessageIds[1] as string)?.verdict).toBe('fire');
  });

  it('an edit keeps both chains on the abandoned row; the fork refills under the current model', async () => {
    const { threadId, userMessageIds } = await seedThread('cross-model edit', TOPIC_SPECS);

    modelState.current = PRIMARY;
    expect((await runLiveGate({ threadId })).type).toBe('success');
    modelState.current = SECONDARY;
    expect((await runLiveGate({ threadId })).type).toBe('success');

    const lastUser = userMessageIds[userMessageIds.length - 1];
    if (!lastUser) throw new Error('seed too short');
    const edit = await editMessage({
      userId: USER_ID,
      threadId,
      messageId: lastUser,
      content: `${TOPIC_SPECS[TOPIC_SPECS.length - 1]?.user ?? ''} — revised${PAD}`,
    });
    expect(edit.type).toBe('success');
    if (edit.type !== 'success') throw new Error('expected success');
    const forkedId = edit.data.id;

    // Both chains keep the abandoned arrival — its reading never changed,
    // so every model's analysis is still correct for it.
    for (const modelId of [PRIMARY, SECONDARY]) {
      const { logs } = await readChain(threadId, modelId);
      expect(logs.map((log) => log.messageId)).toEqual(userMessageIds);
    }

    // The refill judges the forked arrival under the current model…
    await insertMessage({
      threadId,
      role: 'assistant',
      content: `revised reply${PAD}`,
    });
    expect((await runLiveGate({ threadId })).type).toBe('success');
    const { logs: refilled } = await readChain(threadId, SECONDARY);
    expect(refilled.map((log) => log.messageId)).toEqual([...userMessageIds, forkedId]);
    // …while the retired chain keeps it out until its own model walks again.
    const { logs: retired } = await readChain(threadId, PRIMARY);
    expect(retired.map((log) => log.messageId)).toEqual(userMessageIds);
  });
});
