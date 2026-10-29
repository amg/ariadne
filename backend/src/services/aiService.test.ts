import { randomUUID } from 'node:crypto';
import { env } from '@config/env';
import { listMessageEmbeddingsByMessageIds } from '@queries/messageEmbeddings/listMessageEmbeddingsByMessageIds';
import { getMessageUsageByMessageId } from '@queries/messageUsage/getMessageUsageByMessageId';
import { findResumeDraft } from '@queries/messages/findResumeDraft';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  enqueueDriftGateJudgeArrival,
  findDriftGateJudgeArrivalJobOrNull,
} from '@queue/tasks/driftGateJudgeArrivalTask';
import { enqueueThreadGenerateTitle } from '@queue/tasks/threadGenerateTitleTask';
import {
  EMBEDDING_MODEL_ID,
  computeCostUsd,
  embedText,
  isDriftPause,
  retryLastExchange,
  submitChat,
} from '@services/aiService';
import { editMessage } from '@services/messageService';
import { getModelConfig } from '@services/modelConfigService';
import { useAppRecordCapture } from '@test/appRecords';
import { memoryOn } from '@test/memory';
import { useTestQueue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import type { UIMessage } from 'ai';
import { readUIMessageStream } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MOCK_CACHE,
  MOCK_EMBEDDINGS,
  MOCK_REASONING_PARTS,
  type MockInferenceServer,
  buildMockEmbedding,
  startMockInferenceServer,
} from '../../mock/inferenceServer';
import { metricFieldsOf } from '../appRecords/metrics';
import type { ChatStreamHandle, RetryChoice } from '../types/aiService';
import { countTextTokens } from './aiService/usageMap';

/**
 * e2e against the built-in mock inference server (documented deviation:
 * the AI provider is external, so mocks are allowed there only).
 * `MOCK_AI_BASE_URL` points the DeepInfra provider at the mock; env is read
 * lazily at submitChat call time.
 */

let mock: MockInferenceServer;
const savedIdleTimeout = process.env.AI_STREAM_IDLE_TIMEOUT_MS;
const savedStalenessMs = process.env.EXCHANGE_STALENESS_MS;

// Restores the idle timeout env: unset restores as '' (env numbers treat
// unparseable values as absent).
function restoreIdleTimeout(saved: string | undefined) {
  if (saved === undefined) process.env.AI_STREAM_IDLE_TIMEOUT_MS = '';
  else process.env.AI_STREAM_IDLE_TIMEOUT_MS = saved;
}

function setStalenessMs(value: string | undefined) {
  if (value === undefined) process.env.EXCHANGE_STALENESS_MS = '';
  else process.env.EXCHANGE_STALENESS_MS = value;
}

/** The thread's newest assistant row, or undefined when it has none. */
async function newestAssistantRow(threadId: string) {
  const rows = await listMessagesByThread({ threadId });
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.role === 'assistant') return rows[i];
  }
  return undefined;
}

/**
 * Aborts carry no provider usage block, yet the ledger still accounts the
 * exchange. Reads the estimated spend row and verifies its identity fields
 * and its fallback-priced cost over the tokens it stored.
 */
async function readEstimatedSpend(messageId: string) {
  const usage = await getMessageUsageByMessageId({ messageId });
  if (!usage) {
    expect(usage, 'estimated spend row').toBeDefined();
    return usage;
  }
  expect(usage.estimated).toBe(true);
  expect(usage.providerId).toBeNull();
  expect(usage.model).toBe(env.DEFAULT_MODEL);
  const config = await getModelConfig(env.DEFAULT_MODEL);
  expect(Number(usage.costUsd)).toBe(
    computeCostUsd({
      pricing: {
        input: config?.inputPricePerMillion ?? null,
        output: config?.outputPricePerMillion ?? null,
        cachedRateMultiplier: config?.cachedRateMultiplier ?? null,
      },
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
    }),
  );
  return usage;
}

async function drain(handle: ChatStreamHandle) {
  for await (const _message of readUIMessageStream({ stream: handle.stream })) {
    // Consuming the stream lets the exchange settle its persistence.
  }
}

beforeAll(async () => {
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterAll(async () => {
  restoreIdleTimeout(savedIdleTimeout);
  setStalenessMs(savedStalenessMs);
  await mock.stop();
});

async function createRandomThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId: userId, title: 'AI thread' });
  return { userId, threadId: thread.id };
}

async function assertSuccess(
  result: Awaited<ReturnType<typeof submitChat>>,
): Promise<ChatStreamHandle> {
  expect(result.type).toBe('success');
  if (result.type !== 'success') throw new Error('expected success');
  if (isDriftPause(result.data)) throw new Error('expected an exchange, got a drift pause');
  return result.data;
}

// Single lifecycle hook for the whole file: useTestDb() destroys the pool in
// its afterAll, so a per-describe call would kill the DB before later suites.
useTestDb();
useTestQueue({ memory: memoryOn, threadAnalysisMode: 'heuristic' });

const judging = { enqueueDriftGateJudgeArrival, findDriftGateJudgeArrivalJobOrNull };
const titling = { enqueueThreadGenerateTitle };

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

describe('submitChat', () => {
  it('returns thread_not_found for unknown/foreign threads', async () => {
    const { userId } = await createRandomThread();

    const result = await submit({ userId, threadId: randomUUID(), content: 'hi' });

    expect(result).toEqual({ type: 'error', code: 'thread_not_found' });
  });

  it('streams the reply, pins the UI message id to the DB row and persists usage', async () => {
    const { userId, threadId } = await createRandomThread();

    const handle = await assertSuccess(await submit({ userId, threadId, content: 'Hello world' }));

    const messages: UIMessage[] = [];
    for await (const message of readUIMessageStream({ stream: handle.stream })) {
      messages.push(message);
    }
    const outcome = await handle.outcome;

    // The streamed assistant message carries our persisted row id; the
    // reader yields successive states, so take the final one.
    const assistant = messages[messages.length - 1];
    expect(assistant?.id).toBe(handle.assistantMessageId);
    expect(assistant?.role).toBe('assistant');
    const streamedText = assistant?.parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('');
    expect(streamedText).toBe('Mock reply to: Hello world');

    // Outcome: clean finish.
    expect(outcome).toMatchObject({
      type: 'success',
      data: { finishReason: 'stop', usagePersisted: true },
    });

    // Assistant text landed in the messages table.
    const rows = await listMessagesByThread({ threadId });
    expect(rows.map((row) => row.content)).toEqual(['Hello world', 'Mock reply to: Hello world']);

    // The exchange settled its lifecycle state on the assistant row.
    expect((await newestAssistantRow(threadId))?.exchangeStatus).toBe('completed');

    // Usage row: cache telemetry passed through, cost priced from the model
    // config fallback (modelConfigService FALLBACK_CONFIG — the single
    // fallback source: DB → hard-coded default model config).
    const fallbackConfig = await getModelConfig(env.DEFAULT_MODEL);
    const usage = await getMessageUsageByMessageId({
      messageId: handle.assistantMessageId,
    });
    expect(usage).toBeDefined();
    // 1 message in history + the new one → base 4 + 2
    expect(usage?.promptTokens).toBe(MOCK_CACHE.basePromptTokens + 2);
    expect(usage?.completionTokens).toBe('Mock reply to: Hello world'.split(/(?<=\s)/).length);
    expect(usage?.cachedInputTokens).toBe(MOCK_CACHE.cachedInputTokens);
    // ai@7 deduplicates usage and does not expose raw/provider extra fields —
    // cacheWriteTokens stays NULL (omitted) until the SDK spreads it
    // (the fallback path in usageMap.ts is already wired to usage.raw).
    expect(usage?.cacheWriteTokens).toBeNull();
    expect(usage?.model).toBe(env.DEFAULT_MODEL);
    expect(usage?.finishReason).toBe('stop');
    expect(usage?.providerId).toMatch(/^chatcmpl-mock-/);
    expect(usage?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number(usage?.costUsd)).toBe(
      computeCostUsd({
        pricing: {
          input: fallbackConfig?.inputPricePerMillion ?? null,
          output: fallbackConfig?.outputPricePerMillion ?? null,
          cachedRateMultiplier: fallbackConfig?.cachedRateMultiplier ?? null,
        },
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        cachedInputTokens: MOCK_CACHE.cachedInputTokens,
      }),
    );
  });

  /** The chat request body sent for one exchange under the given ENABLE_REASONING value. */
  async function chatRequestWithReasoning(enabled: 'true' | 'false') {
    const { userId, threadId } = await createRandomThread();
    const saved = process.env.ENABLE_REASONING;
    process.env.ENABLE_REASONING = enabled;
    try {
      await drain(await assertSuccess(await submit({ userId, threadId, content: 'think?' })));
    } finally {
      process.env.ENABLE_REASONING = saved ?? '';
    }
    return mock.chats.lastRequest();
  }

  it('sends the model the whole live conversation, without abandoned or empty rows', async () => {
    const { userId, threadId } = await createRandomThread();
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const stored = [
      { role: 'user', content: 'one TOPIC:hiking' },
      { role: 'assistant', content: 'reply one TOPIC:hiking' },
      { role: 'user', content: 'two TOPIC:hiking' },
      { role: 'assistant', content: '', exchangeStatus: 'interrupted' },
      { role: 'assistant', content: 'stale reply TOPIC:hiking', abandoned: true },
      { role: 'assistant', content: 'reply two TOPIC:hiking' },
      { role: 'user', content: 'edited away TOPIC:hiking', abandoned: true },
    ] as const;
    for (const [index, row] of stored.entries()) {
      await insertMessage({ ...row, threadId, createdAt: minutesAgo(stored.length - index) });
    }

    const handle = await assertSuccess(
      await submit({ userId, threadId, content: 'three TOPIC:hiking' }),
    );
    await drain(handle);
    await expect(handle.outcome).resolves.toMatchObject({ type: 'success' });

    // The mock keeps the request body it received untyped.
    const sent = mock.chats.lastRequest()?.messages as { role: string; content: string }[];
    expect(sent.filter((message) => message.role !== 'system')).toEqual([
      { role: 'user', content: 'one TOPIC:hiking' },
      { role: 'assistant', content: 'reply one TOPIC:hiking' },
      { role: 'user', content: 'two TOPIC:hiking' },
      { role: 'assistant', content: 'reply two TOPIC:hiking' },
      { role: 'user', content: 'three TOPIC:hiking' },
    ]);
  });

  it('lets the model think when reasoning is enabled', async () => {
    const request = await chatRequestWithReasoning('true');
    expect(request?.chat_template_kwargs).toBeUndefined();
  });

  it('turns the thinking phase off when reasoning is disabled', async () => {
    const request = await chatRequestWithReasoning('false');
    expect(request?.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('estimates reasoning tokens from the streamed reasoning text', async () => {
    const { userId, threadId } = await createRandomThread();

    const handle = await assertSuccess(
      await submit({ userId, threadId, content: 'THINK: why is the sky blue?' }),
    );
    await drain(handle);
    await handle.outcome;

    const usage = await getMessageUsageByMessageId({ messageId: handle.assistantMessageId });
    expect(usage?.estimatedReasoningTokens).toBe(countTextTokens(MOCK_REASONING_PARTS.join('')));
  });

  it('persists partial text with finish state "interrupted" when stopped early', async () => {
    const { userId, threadId } = await createRandomThread();

    const handle = await assertSuccess(
      // PAUSE:200 suspends the mock between token 1 and 2 → room to stop.
      await submit({ userId, threadId, content: 'stop me please PAUSE:200' }),
    );

    const reader = handle.stream.getReader();
    // Abort only after the first tokens have started arriving.
    let sawText = false;
    while (!sawText) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.type === 'text-delta') sawText = true;
    }
    handle.abort();

    const outcome = await handle.outcome;
    expect(outcome).toMatchObject({
      type: 'success',
      data: { finishReason: 'interrupted', usagePersisted: true },
    });

    // Partial text persisted (first token only, before the pause).
    const rows = await listMessagesByThread({ threadId });
    const assistantRow = rows.find((row) => row.role === 'assistant');
    expect(assistantRow?.content).toBe('Mock ');

    // No provider usage block arrived, yet the exchange still accounts
    // its spend: an estimated ledger row from the locally counted input
    // tokens and the text that made it out.
    const usage = await readEstimatedSpend(handle.assistantMessageId);
    expect(usage?.finishReason).toBe('interrupted');
    expect(usage?.promptTokens ?? 0).toBeGreaterThan(0);
    expect(usage?.completionTokens ?? 0).toBeGreaterThan(0);
    expect(usage?.latencyMs ?? -1).toBeGreaterThanOrEqual(0);

    // A deliberate stop settles the exchange as interrupted, releasing the thread.
    expect(assistantRow?.exchangeStatus).toBe('interrupted');

    // Interruption abandons nothing: user row stays non-abandoned, no resume draft.
    const userRow = rows.find((row) => row.role === 'user');
    expect(userRow?.abandoned).toBe(false);
    const draft = await findResumeDraft({ threadId });
    expect(draft).toBeUndefined();
    // The thread already has its title — the interruption leaves it alone.
    expect((await findThreadByIdAndUser({ userId, threadId }))?.title).toBe('AI thread');
  });

  it('titles a still-untitled thread from the interrupted arrival text', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const thread = await insertThread({ userId });

    const handle = await assertSuccess(
      await submit({
        userId,
        threadId: thread.id,
        content: `${'abcd '.repeat(12).trim()}`,
      }),
    );
    handle.abort();
    const outcome = await handle.outcome;
    expect(outcome).toMatchObject({
      type: 'success',
      data: { finishReason: 'interrupted' },
    });

    // Wait for the title preview to settle (it's set in the outcome handler).
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Title preview still lands from the arrival text; no abandonment.
    const rows = await listMessagesByThread({ threadId: thread.id });
    const userRow = rows.find((row) => row.role === 'user');
    expect(userRow?.abandoned).toBe(false);
    // Over the char cap: clipped at the boundary and ellipsized.
    expect((await findThreadByIdAndUser({ userId, threadId: thread.id }))?.title).toBe(
      `${'abcd '.repeat(10).trim()}\u2026`,
    );
  });

  it('queues a still-untitled thread\u2019s titling once its Exchange settles', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const thread = await insertThread({ userId });

    const handle = await assertSuccess(
      await submit({ userId, threadId: thread.id, content: 'Hello world' }),
    );
    await drain(handle);
    await handle.outcome;

    // The titling runs on the queue after settlement; poll until it lands.
    const deadline = Date.now() + 20_000;
    let title: string | null = null;
    while (Date.now() < deadline) {
      title = (await findThreadByIdAndUser({ userId, threadId: thread.id }))?.title ?? null;
      if (title) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // A generated title, not the interrupted-exchange preview of the arrival.
    expect(title).toBeTruthy();
    expect(title).not.toBe('Hello world');
  });

  it('an interrupted exchange leaves no resume draft; retrying completes it', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const thread = await insertThread({ userId });

    const interrupted = await assertSuccess(
      await submit({ userId, threadId: thread.id, content: 'retry me please PAUSE:200' }),
    );
    interrupted.abort();
    await interrupted.outcome;
    // Interruption abandons nothing: no draft created.
    expect(await findResumeDraft({ threadId: thread.id })).toBeUndefined();

    // Retrying the interrupted exchange completes it beneath the partial reply.
    const retry = await assertSuccess(await retryExchange({ userId, threadId: thread.id }));
    await drain(retry);
    expect(await retry.outcome).toMatchObject({
      type: 'success',
      data: { finishReason: 'stop' },
    });
    expect(await findResumeDraft({ threadId: thread.id })).toBeUndefined();
  });

  it('edits fork: the abandoned arrival keeps tracking pre-edit cost, the retry exchanges the forked row', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const thread = await insertThread({ userId });

    const original = await assertSuccess(
      await submit({ userId, threadId: thread.id, content: 'original question PAUSE:200' }),
    );
    const reader = original.stream.getReader();
    let sawText = false;
    while (!sawText) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.type === 'text-delta') sawText = true;
    }
    original.abort();
    await original.outcome;

    // Interruption abandons nothing: user row stays non-abandoned.
    const rowsBeforeEdit = await listMessagesByThread({ threadId: thread.id });
    const originalUserRow = rowsBeforeEdit.find((row) => row.role === 'user');
    expect(originalUserRow?.abandoned).toBe(false);

    // The edit forks: abandoned arrival kept intact, edited text inserted.
    const edit = await editMessage({
      judging,
      userId,
      threadId: thread.id,
      messageId: originalUserRow?.id as string,
      content: 'a reworded question',
    });
    expect(edit.type).toBe('success');

    // The retry exchanges the forked row — its live gate runs for the
    // first time there — and completes.
    const retry = await assertSuccess(await retryExchange({ userId, threadId: thread.id }));
    await drain(retry);
    expect(await retry.outcome).toMatchObject({
      type: 'success',
      data: { finishReason: 'stop' },
    });

    // History keeps the abandoned turn before the forked exchange.
    const rows = await listMessagesByThread({ threadId: thread.id });
    expect(rows.map((row) => [row.role, row.abandoned])).toEqual([
      ['user', true],
      ['assistant', true],
      ['user', false],
      ['assistant', false],
    ]);
    expect(rows.find((row) => row.abandoned)?.content).toBe('original question PAUSE:200');

    // Both arrivals carry arrival rows: the old one replayed, the forked
    // one judged by the retry's gate pass.
    const userIds = rows.filter((row) => row.role === 'user').map((row) => row.id);
    const arrivals = await listMessageEmbeddingsByMessageIds({
      messageIds: userIds,
      modelId: EMBEDDING_MODEL_ID,
    });
    expect(new Set(arrivals.map((row) => row.messageId))).toEqual(new Set(userIds));

    // Nothing is owed back: the forked row is not abandoned.
    expect(await findResumeDraft({ threadId: thread.id })).toBeUndefined();
  });

  it('settles a before-first-token stop without stranding the row as pending', async () => {
    const { userId, threadId } = await createRandomThread();

    const handle = await assertSuccess(
      await submit({ userId, threadId, content: 'stopped before any token' }),
    );
    // Never consuming the stream means no token is ever recorded; the stop
    // aborts with nothing to persist but the exchange state.
    handle.abort();

    const outcome = await handle.outcome;
    expect(outcome).toMatchObject({
      type: 'success',
      data: { finishReason: 'interrupted', usagePersisted: true },
    });

    const assistantRow = await newestAssistantRow(threadId);
    expect(assistantRow?.content).toBe('');
    expect(assistantRow?.exchangeStatus).toBe('interrupted');

    // The prompt was billed even though no output token made it out: the
    // estimated row accounts the input alone.
    const usage = await readEstimatedSpend(handle.assistantMessageId);
    expect(usage?.finishReason).toBe('interrupted');
    expect(usage?.promptTokens ?? 0).toBeGreaterThan(0);
    expect(usage?.completionTokens).toBe(0);

    // The settled row must not trip the in-flight guard on the next submit.
    // (The mock embeds every distinct text far apart, so this second
    // arrival is a drift fire and pauses instead of exchanging.)
    const next = await submit({ userId, threadId, content: 'all clear again' });
    expect(next.type).toBe('success');
  });

  it('aborts on the inter-token idle deadline with stream_timeout', async () => {
    const { userId, threadId } = await createRandomThread();
    process.env.AI_STREAM_IDLE_TIMEOUT_MS = '30';

    try {
      const handle = await assertSuccess(
        // 300ms gap blows the 30ms idle deadline after the first token.
        await submit({ userId, threadId, content: 'slow reply PAUSE:300' }),
      );

      const outcome = await handle.outcome;
      expect(outcome).toMatchObject({ type: 'error', code: 'stream_timeout' });

      const rows = await listMessagesByThread({ threadId });
      const assistantRow = rows.find((row) => row.role === 'assistant');
      expect(assistantRow?.content).toBe('Mock ');
      // The watchdog's abort is a failure, not a deliberate stop.
      expect(assistantRow?.exchangeStatus).toBe('error');

      // The failed exchange still settles its estimated spend, tagged
      // with the timeout finish.
      const usage = await readEstimatedSpend(handle.assistantMessageId);
      expect(usage?.finishReason).toBe('timeout');
    } finally {
      restoreIdleTimeout(savedIdleTimeout);
    }
  });
});

describe('exchange in-flight guard', () => {
  /** Starts a paused exchange: first token out, stream suspended between tokens. */
  async function startRunningExchange(threadId: string, userId: string) {
    const handle = await assertSuccess(
      await submit({ userId, threadId, content: 'hold still PAUSE:20000' }),
    );
    const reader = handle.stream.getReader();
    let sawText = false;
    while (!sawText) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.type === 'text-delta') sawText = true;
    }
    return handle;
  }

  it('rejects a second submit or retry while an exchange is pending', async () => {
    const { userId, threadId } = await createRandomThread();
    const running = await startRunningExchange(threadId, userId);

    try {
      const second = await submit({ userId, threadId, content: 'double bill' });
      expect(second).toEqual({
        type: 'error',
        code: 'exchange_in_flight',
        message: 'An exchange is already running in this thread.',
      });

      const retry = await retryExchange({ userId, threadId });
      expect(retry).toMatchObject({ type: 'error', code: 'exchange_in_flight' });
    } finally {
      running.abort();
      await running.outcome;
    }
  });

  it('lets a retry regenerate a thread ending in a stale pending row', async () => {
    setStalenessMs('60000');
    try {
      const { userId, threadId } = await createRandomThread();
      const userMessage = await insertMessage({
        threadId,
        role: 'user',
        content: 'orphan prompt',
        createdAt: new Date(Date.now() - 130_000),
      });
      const orphan = await insertMessage({
        threadId,
        role: 'assistant',
        content: '',
        exchangeStatus: 'pending',
        // Dated beyond the staleness window: its exchange's process is gone.
        createdAt: new Date(Date.now() - 120_000),
      });

      const handle = await assertSuccess(await retryExchange({ userId, threadId }));
      await drain(handle);
      await expect(handle.outcome).resolves.toMatchObject({ type: 'success' });

      // The stale pending row survives as flagged abandoned; the fresh
      // answer lands beneath it.
      const rows = await listMessagesByThread({ threadId });
      expect(rows.map((row) => row.id)).toEqual([
        userMessage.id,
        orphan.id,
        handle.assistantMessageId,
      ]);
      expect(rows[1]?.abandoned).toBe(true);
      expect(rows[2]?.exchangeStatus).toBe('completed');
      expect(rows.some((row) => row.id === orphan.id)).toBe(true);
      // The crashed exchange still accounts its spend, as an estimate.
      const orphanUsage = await getMessageUsageByMessageId({ messageId: orphan.id });
      expect(orphanUsage?.estimated).toBe(true);
      expect(orphanUsage?.finishReason).toBe('interrupted');
    } finally {
      setStalenessMs(savedStalenessMs);
    }
  });

  it('releases a thread whose pending row outlived the staleness window', async () => {
    setStalenessMs('60000');
    try {
      const { userId, threadId } = await createRandomThread();
      const orphan = await insertMessage({
        threadId,
        role: 'assistant',
        content: '',
        exchangeStatus: 'pending',
        createdAt: new Date(Date.now() - 120_000),
      });

      const handle = await assertSuccess(await submit({ userId, threadId, content: 'recovered' }));
      await drain(handle);
      await expect(handle.outcome).resolves.toMatchObject({ type: 'success' });

      // The orphaned row settled as interrupted instead of blocking forever.
      const orphaned = await newestAssistantRow(orphan.threadId);
      const rows = await listMessagesByThread({ threadId });
      expect(rows.find((row) => row.id === orphan.id)?.exchangeStatus).toBe('interrupted');
      expect(orphaned?.id).toBe(handle.assistantMessageId);
      expect(orphaned?.exchangeStatus).toBe('completed');
    } finally {
      setStalenessMs(savedStalenessMs);
    }
  });
});

describe('retryLastExchange', () => {
  it('returns thread_not_found for unknown/foreign threads and nothing_to_regenerate on empty ones', async () => {
    const { userId, threadId } = await createRandomThread();

    const unknown = await retryExchange({ userId, threadId: randomUUID() });
    const empty = await retryExchange({ userId, threadId });

    expect(unknown).toEqual({ type: 'error', code: 'thread_not_found' });
    expect(empty).toEqual({ type: 'error', code: 'nothing_to_regenerate' });
  });

  it('keeps the stale reply abandoned and answers fresh beneath it', async () => {
    const { userId, threadId } = await createRandomThread();

    const first = await assertSuccess(await submit({ userId, threadId, content: 'retry me' }));
    await drain(first);
    await expect(first.outcome).resolves.toMatchObject({ type: 'success' });

    const retry = await assertSuccess(await retryExchange({ userId, threadId }));
    const messages: UIMessage[] = [];
    for await (const message of readUIMessageStream({ stream: retry.stream })) {
      messages.push(message);
    }
    await expect(retry.outcome).resolves.toMatchObject({ type: 'success' });
    expect((await newestAssistantRow(threadId))?.exchangeStatus).toBe('completed');

    const streamed = messages[messages.length - 1];
    expect(streamed?.id).toBe(retry.assistantMessageId);

    // The stale answer stays — flagged abandoned — with the fresh answer
    // beneath it; both exchanges' spend keep tracking on their rows.
    const rows = await listMessagesByThread({ threadId });
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(rows[1]?.id).toBe(first.assistantMessageId);
    expect(rows[1]?.abandoned).toBe(true);
    expect(rows[2]?.id).toBe(retry.assistantMessageId);
    expect(rows[2]?.abandoned).toBe(false);
    const text = rows[2]?.content ?? '';
    expect(text).toContain('retry me');
    expect(await getMessageUsageByMessageId({ messageId: first.assistantMessageId })).toBeDefined();
    expect(await getMessageUsageByMessageId({ messageId: retry.assistantMessageId })).toBeDefined();
  });

  it('continues a thread that ends in a user row without duplicating it', async () => {
    const { userId, threadId } = await createRandomThread();
    const userMessage = await insertMessage({
      threadId: threadId,
      role: 'user',
      content: 'stuck prompt',
    });

    const handle = await assertSuccess(await retryExchange({ userId, threadId }));
    const messages: UIMessage[] = [];
    for await (const message of readUIMessageStream({ stream: handle.stream })) {
      messages.push(message);
    }
    await expect(handle.outcome).resolves.toMatchObject({
      type: 'success',
      data: { finishReason: 'stop' },
    });

    const rows = await listMessagesByThread({ threadId });
    expect(rows.map((row) => row.id)).toEqual([userMessage.id, handle.assistantMessageId]);
    expect(rows[1]?.content).toBe('Mock reply to: stuck prompt');
  });
});

describe('daily spend budget', () => {
  const savedBudget = process.env.DAILY_SPEND_BUDGET_USD;

  // A zero budget is reached by any day's spend, the empty one included.
  function exhaustBudget() {
    process.env.DAILY_SPEND_BUDGET_USD = '0';
  }

  afterEach(() => {
    process.env.DAILY_SPEND_BUDGET_USD = savedBudget ?? '';
  });

  function expectBudgetExceeded(result: Awaited<ReturnType<typeof submitChat>>) {
    expect(result).toMatchObject({ type: 'error', code: 'budget_exceeded' });
    expect(result.type === 'error' && 'retryAfter' in result && result.retryAfter).toBeGreaterThan(
      0,
    );
  }

  it('refuses a submit without storing the arrival', async () => {
    const { userId, threadId } = await createRandomThread();
    exhaustBudget();

    expectBudgetExceeded(await submit({ userId, threadId, content: 'over budget' }));

    expect(await listMessagesByThread({ threadId })).toEqual([]);
  });

  it('refuses a retry of an answered arrival and keeps its reply live', async () => {
    const { userId, threadId } = await createRandomThread();
    const first = await assertSuccess(await submit({ userId, threadId, content: 'answered' }));
    await drain(first);
    await expect(first.outcome).resolves.toMatchObject({ type: 'success' });
    const before = await listMessagesByThread({ threadId });
    exhaustBudget();

    expectBudgetExceeded(await retryExchange({ userId, threadId }));

    expect(await listMessagesByThread({ threadId })).toEqual(before);
  });

  // An unanswered arrival is what an Edit, a Handover's first reply and a
  // Paused arrival's continue all ask a reply for.
  it.each<RetryChoice>(['retry', 'continue'])(
    'refuses a %s on an unanswered arrival before the Drift gate',
    async (choice) => {
      const { userId, threadId } = await createRandomThread();
      const arrival = await insertMessage({ threadId, role: 'user', content: 'unanswered' });
      exhaustBudget();

      expectBudgetExceeded(await retryExchange({ userId, threadId }, choice));

      const rows = await listMessagesByThread({ threadId });
      expect(rows.map((row) => row.id)).toEqual([arrival.id]);
      expect(await findDriftGateJudgeArrivalJobOrNull(arrival.id)).toBeNull();
    },
  );
});

describe('embedText', () => {
  function assertEmbedSuccess(result: Awaited<ReturnType<typeof embedText>>) {
    expect(result.type).toBe('success');
    if (result.type !== 'success') throw new Error('expected success');
    return result.data;
  }

  it('embeds through the mock provider with usage and deterministic vectors', async () => {
    const text = 'drift window text';
    const first = assertEmbedSuccess(await embedText(text));
    const same = assertEmbedSuccess(await embedText(text));
    const other = assertEmbedSuccess(await embedText('a different topic'));

    // Deterministic per content (the mock seam contract).
    expect(same).toEqual(first);

    expect(first.embedding).toHaveLength(1024);
    expect(first.embedding).toEqual(buildMockEmbedding(text));
    expect(other.embedding).not.toEqual(first.embedding);
    expect(first.promptTokens).toBe(MOCK_EMBEDDINGS.basePromptTokens + Math.ceil(text.length / 4));
  });
});

describe('computeCostUsd', () => {
  // Pure cost math — pricing is passed in explicitly (resolved upstream
  // by modelConfigService); these values mirror the default model pricing.
  const pricing = { input: 0.1, output: 0.15 };

  it('prices at the given per-million rates', () => {
    expect(computeCostUsd({ pricing, promptTokens: 1_000_000, completionTokens: 0 })).toBe(0.1);
    expect(computeCostUsd({ pricing, promptTokens: 0, completionTokens: 1_000_000 })).toBe(0.15);
    expect(computeCostUsd({ pricing, promptTokens: 5, completionTokens: 1 })).toBe(0.00000065);
  });

  it('returns 0 when pricing is unknown (null)', () => {
    expect(computeCostUsd({ pricing: null, promptTokens: 10, completionTokens: 10 })).toBe(0);
  });
});

describe('the Exchange record', () => {
  const capture = useAppRecordCapture();

  /** The record is written as the outcome settles, ahead of anything awaiting that outcome. */
  const exchangeRecords = async () => capture.written('exchange');

  it('says when the request arrived, what the gate answered, when the first token streamed and how it ended', async () => {
    const { userId, threadId } = await createRandomThread();

    const handle = await assertSuccess(
      await submit({ userId, threadId, content: 'Private words about my day' }),
    );
    await drain(handle);
    await handle.outcome;

    const lines = await exchangeRecords();
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      userId,
      trigger: 'submit',
      outcome: 'completed',
      errorCode: null,
      assistantMessageId: handle.assistantMessageId,
    });
    expect(['muted', 'pass', 'off']).toContain(line?.verdict);
    expect(line?.verdictAfterMs).not.toBeNull();
    expect(line?.firstTokenAfterMs).toBeGreaterThanOrEqual(line?.verdictAfterMs ?? Number.NaN);
    expect(line?.endedAfterMs).toBeGreaterThanOrEqual(line?.firstTokenAfterMs ?? Number.NaN);
    expect(JSON.stringify(lines)).not.toContain('Private words');
    expect(JSON.stringify(lines)).not.toContain('Mock reply');
  });

  it('records a reply the user stopped as interrupted', async () => {
    const { userId, threadId } = await createRandomThread();
    const handle = await assertSuccess(
      await submit({ userId, threadId, content: 'hold still PAUSE:20000' }),
    );
    const reader = handle.stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done || value?.type === 'text-delta') break;
    }

    handle.abort();
    await handle.outcome;

    expect(await exchangeRecords()).toMatchObject([
      { outcome: 'interrupted', assistantMessageId: handle.assistantMessageId },
    ]);
  });

  it('records a request refused before anything started, with its code', async () => {
    const { userId } = await createRandomThread();

    await submit({ userId, threadId: randomUUID(), content: 'hi' });

    expect(await exchangeRecords()).toMatchObject([
      { userId, outcome: 'refused', errorCode: 'thread_not_found', firstTokenAfterMs: null },
    ]);
  });

  it('records a retry as a retry, with the verdict the arrival already had', async () => {
    const { userId, threadId } = await createRandomThread();
    const first = await assertSuccess(await submit({ userId, threadId, content: 'retry me' }));
    await drain(first);
    await first.outcome;
    const firstVerdict = (await exchangeRecords())[0]?.verdict;

    const retry = await assertSuccess(await retryExchange({ userId, threadId }));
    await drain(retry);
    await retry.outcome;

    const lines = await exchangeRecords();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      trigger: 'retry',
      outcome: 'completed',
      assistantMessageId: retry.assistantMessageId,
    });
    expect(lines[1]?.verdict).toBe(firstVerdict);
  });

  it('publishes the verdict once, though a retry replays it', async () => {
    const { userId, threadId } = await createRandomThread();
    const first = await assertSuccess(await submit({ userId, threadId, content: 'count me once' }));
    await drain(first);
    await first.outcome;
    const retry = await assertSuccess(await retryExchange({ userId, threadId }));
    await drain(retry);
    await retry.outcome;

    const lines = await exchangeRecords();
    const published = lines.map((line) => metricFieldsOf(line, new Date()).GateVerdicts ?? 0);

    expect(lines.map((line) => line.verdictReplayed)).toEqual([false, true]);
    expect(published).toEqual([1, 0]);
  });
});
