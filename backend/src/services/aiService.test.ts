import { randomUUID } from 'node:crypto';
import { env } from '@config/env';
import { getMessageUsageByMessageId } from '@queries/messageUsage/getMessageUsageByMessageId';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  type ChatStreamHandle,
  computeCostUsd,
  retryLastExchange,
  submitChat,
} from '@services/aiService';
import { getModelConfig } from '@services/modelConfigService';
import { useTestDb } from '@test/test-db';
import type { UIMessage } from 'ai';
import { readUIMessageStream } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MOCK_CACHE,
  type MockInferenceServer,
  startMockInferenceServer,
} from '../../mock/inferenceServer';

/**
 * e2e against the built-in mock inference server (documented deviation:
 * the AI provider is external, so mocks are allowed there only).
 * `MOCK_AI_BASE_URL` points the DeepInfra provider at the mock; env is read
 * lazily at submitChat call time.
 */

let mock: MockInferenceServer;
const savedIdleTimeout = process.env.AI_STREAM_IDLE_TIMEOUT_MS;

// Restores the idle timeout env: '' parses to NaN and falls back to the default.
function restoreIdleTimeout(saved: string | undefined) {
  if (saved === undefined) process.env.AI_STREAM_IDLE_TIMEOUT_MS = '';
  else process.env.AI_STREAM_IDLE_TIMEOUT_MS = saved;
}

beforeAll(async () => {
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterAll(async () => {
  restoreIdleTimeout(savedIdleTimeout);
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
  return result.data;
}

// Single lifecycle hook for the whole file: useTestDb() destroys the pool in
// its afterAll, so a per-describe call would kill the DB before later suites.
useTestDb();

describe('submitChat', () => {
  it('returns thread_not_found for unknown/foreign threads', async () => {
    const { userId } = await createRandomThread();

    const result = await submitChat({ userId, threadId: randomUUID(), content: 'hi' });

    expect(result).toEqual({ type: 'error', code: 'thread_not_found' });
  });

  it('streams the reply, pins the UI message id to the DB row and persists usage', async () => {
    const { userId, threadId } = await createRandomThread();

    const handle = await assertSuccess(
      await submitChat({ userId, threadId, content: 'Hello world' }),
    );

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

    // Usage row: cache telemetry passed through, cost priced from the model
    // config fallback (modelConfigService FALLBACK_CONFIG — the single
    // fallback source: DB → hard-coded default model config).
    const fallbackConfig = await getModelConfig(env.DEFAULT_MODEL);
    const usage = await getMessageUsageByMessageId({ messageId: handle.assistantMessageId });
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

  it('persists partial text with finish state "interrupted" when stopped early', async () => {
    const { userId, threadId } = await createRandomThread();

    const handle = await assertSuccess(
      // PAUSE:200 suspends the mock between token 1 and 2 → room to stop.
      await submitChat({ userId, threadId, content: 'stop me please PAUSE:200' }),
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
      data: { finishReason: 'interrupted', usagePersisted: false },
    });

    // Partial text persisted (first token only, before the pause).
    const rows = await listMessagesByThread({ threadId });
    const assistantRow = rows.find((row) => row.role === 'assistant');
    expect(assistantRow?.content).toBe('Mock ');

    // Usage block never arrived → no usage row.
    const usage = await getMessageUsageByMessageId({ messageId: handle.assistantMessageId });
    expect(usage).toBeUndefined();
  });

  it('aborts on the inter-token idle deadline with stream_timeout', async () => {
    const { userId, threadId } = await createRandomThread();
    process.env.AI_STREAM_IDLE_TIMEOUT_MS = '30';

    try {
      const handle = await assertSuccess(
        // 300ms gap blows the 30ms idle deadline after the first token.
        await submitChat({ userId, threadId, content: 'slow reply PAUSE:300' }),
      );

      const outcome = await handle.outcome;
      expect(outcome).toMatchObject({ type: 'error', code: 'stream_timeout' });

      const rows = await listMessagesByThread({ threadId });
      const assistantRow = rows.find((row) => row.role === 'assistant');
      expect(assistantRow?.content).toBe('Mock ');
    } finally {
      restoreIdleTimeout(savedIdleTimeout);
    }
  });
});

describe('retryLastExchange', () => {
  it('returns thread_not_found for unknown/foreign threads and nothing_to_regenerate on empty ones', async () => {
    const { userId, threadId } = await createRandomThread();

    const unknown = await retryLastExchange({ userId, threadId: randomUUID() });
    const empty = await retryLastExchange({ userId, threadId });

    expect(unknown).toEqual({ type: 'error', code: 'thread_not_found' });
    expect(empty).toEqual({ type: 'error', code: 'nothing_to_regenerate' });
  });

  it('replaces a stale assistant reply (row + usage cascade) with a fresh exchange', async () => {
    const { userId, threadId } = await createRandomThread();

    const first = await assertSuccess(await submitChat({ userId, threadId, content: 'retry me' }));
    for await (const _message of readUIMessageStream({ stream: first.stream })) {
      // Drain so persistence settles before the retry re-lists the thread.
    }
    await expect(first.outcome).resolves.toMatchObject({ type: 'success' });

    const retry = await assertSuccess(await retryLastExchange({ userId, threadId }));
    const messages: UIMessage[] = [];
    for await (const message of readUIMessageStream({ stream: retry.stream })) {
      messages.push(message);
    }
    await expect(retry.outcome).resolves.toMatchObject({ type: 'success' });

    const streamed = messages[messages.length - 1];
    expect(streamed?.id).toBe(retry.assistantMessageId);

    const rows = await listMessagesByThread({ threadId });
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant']);
    expect(rows[1]?.id).toBe(retry.assistantMessageId);
    expect(rows[1]?.id).not.toBe(first.assistantMessageId);
    const text = rows[1]?.content ?? '';
    expect(text).toContain('retry me');

    // Old usage row cascaded with the deleted message; fresh reply has its own.
    expect(
      await getMessageUsageByMessageId({ messageId: first.assistantMessageId }),
    ).toBeUndefined();
    expect(await getMessageUsageByMessageId({ messageId: retry.assistantMessageId })).toBeDefined();
  });

  it('continues a thread that ends in a user row without duplicating it', async () => {
    const { userId, threadId } = await createRandomThread();
    const userMessage = await insertMessage({
      threadId: threadId,
      role: 'user',
      content: 'stuck prompt',
    });

    const handle = await assertSuccess(await retryLastExchange({ userId, threadId }));
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
