import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import type { Message } from '@db/types';
import { insertMessage } from '@queries/messages/insertMessage';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { insertSegmentDriftLog } from '@queries/segmentDriftLogs/insertSegmentDriftLog';
import { insertThreadSegment } from '@queries/threadSegments/insertThreadSegment';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserFact } from '@queries/userFacts/insertUserFact';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import {
  assembledSystemPrompt,
  captureClosedSegments,
  captureFacts,
  renderedSeedOrNull,
  segmentTurns,
} from '@services/memory';
import { updateUserSettings } from '@services/settingsService';
import { createThread } from '@services/threadService';
import { useTestDb } from '@test/test-db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type MockInferenceServer,
  buildMockEmbedding,
  startMockInferenceServer,
} from '../../mock/inferenceServer';

let mock: MockInferenceServer;

beforeAll(async () => {
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterAll(async () => {
  await mock.stop();
});

beforeEach(() => {
  mock.memory.forceExtraction(null);
  mock.memory.clearFailures();
});

useTestDb();

async function createUserAndThread(): Promise<{ userId: string; threadId: string }> {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId, title: 'Memory thread' });
  return { userId, threadId: thread.id };
}

async function addTurn(
  threadId: string,
  userText: string,
  assistantText = 'Noted.',
): Promise<{ user: Message; assistant: Message }> {
  const user = await insertMessage({ threadId, role: 'user', content: userText });
  const assistant = await insertMessage({ threadId, role: 'assistant', content: assistantText });
  return { user, assistant };
}

async function factsOf(userId: string) {
  return db
    .selectFrom('userFacts')
    .select(['content', 'category', 'predicate', 'sourceMessageId', 'suppressed'])
    .where('userId', '=', userId)
    .orderBy('createdAt', 'asc')
    .execute();
}

async function costsOf(messageId: string) {
  return db
    .selectFrom('messageSideCosts')
    .select(['kind', 'promptTokens'])
    .where('messageId', '=', messageId)
    .orderBy('kind', 'asc')
    .execute();
}

/** A thread whose first segment holds the given turns and a fire closed it. */
async function threadWithClosedSegment(turnTexts: string[]) {
  const { userId, threadId } = await createUserAndThread();
  const turns = [];
  for (const text of turnTexts) turns.push(await addTurn(threadId, text));
  const boundary = await insertMessage({ threadId, role: 'user', content: 'Totally new topic' });
  const first = turns[0];
  if (!first) throw new Error('at least one turn');
  const segment = await insertThreadSegment({
    threadId,
    startMessageId: first.user.id,
    modelId: EMBEDDING_MODEL_ID,
  });
  await insertSegmentDriftLog({
    segmentId: segment.id,
    messageId: boundary.id,
    modelId: EMBEDDING_MODEL_ID,
    verdict: 'fire',
    fireChannel: 'immediate',
  });
  await insertThreadSegment({ threadId, startMessageId: boundary.id, modelId: EMBEDDING_MODEL_ID });
  return { userId, threadId, turns, boundary, segmentId: segment.id };
}

async function capturedAt(segmentId: string): Promise<Date | null> {
  const row = await db
    .selectFrom('threadSegments')
    .select('factsCapturedAt')
    .where('id', '=', segmentId)
    .executeTakeFirstOrThrow();
  return row.factsCapturedAt;
}

describe('captureFacts', () => {
  it('stores extracted Facts with their source Turn and records the spend', async () => {
    const { userId, threadId } = await createUserAndThread();
    const first = await addTurn(threadId, 'I love hiking in the Alps');
    const second = await addTurn(threadId, 'I work as a carpenter');

    const result = await captureFacts({
      userId,
      turns: [
        { userMessage: first.user, assistantReply: first.assistant },
        { userMessage: second.user, assistantReply: second.assistant },
      ],
      blockedCategories: [],
      spendMessageId: second.user.id,
    });

    expect(result).toEqual({ type: 'success', data: { added: 2, skippedAsDuplicate: 0 } });
    expect(await factsOf(userId)).toEqual([
      {
        content: 'The user loves hiking in the Alps.',
        category: 'preference',
        predicate: 'loves',
        sourceMessageId: first.user.id,
        suppressed: false,
      },
      {
        content: 'The user works as a carpenter.',
        category: 'work',
        predicate: 'works',
        sourceMessageId: second.user.id,
        suppressed: false,
      },
    ]);
    const costs = await costsOf(second.user.id);
    expect(costs.map((cost) => cost.kind)).toEqual(['fact_embedding', 'fact_extraction']);
  });

  it('skips a Fact the Memory already holds without a duplicate check', async () => {
    const { userId, threadId } = await createUserAndThread();
    const turn = await addTurn(threadId, 'I love hiking in the Alps');
    const input = {
      userId,
      turns: [{ userMessage: turn.user, assistantReply: turn.assistant }],
      blockedCategories: [],
      spendMessageId: turn.user.id,
    };
    await captureFacts(input);
    const checksBefore = mock.memory.duplicateCheckCount();

    const again = await captureFacts(input);

    expect(again).toEqual({ type: 'success', data: { added: 0, skippedAsDuplicate: 1 } });
    expect(mock.memory.duplicateCheckCount()).toBe(checksBefore);
    expect(await factsOf(userId)).toHaveLength(1);
    // A repeated run adds its spend to the same rows instead of replacing them.
    const extraction = (await costsOf(turn.user.id)).find((c) => c.kind === 'fact_extraction');
    expect(extraction?.promptTokens).toBeGreaterThan(0);
  });

  it('drops candidates in blocked categories', async () => {
    const { userId, threadId } = await createUserAndThread();
    const turn = await addTurn(threadId, 'I love jazz');
    const other = await addTurn(threadId, 'I live in Lisbon');

    await captureFacts({
      userId,
      turns: [
        { userMessage: turn.user, assistantReply: turn.assistant },
        { userMessage: other.user, assistantReply: other.assistant },
      ],
      blockedCategories: ['preference'],
      spendMessageId: other.user.id,
    });

    expect((await factsOf(userId)).map((fact) => fact.category)).toEqual(['location']);
  });

  it('fails without storing anything when the extraction reply is unreadable', async () => {
    const { userId, threadId } = await createUserAndThread();
    const turn = await addTurn(threadId, 'I love jazz');
    mock.memory.forceExtraction('Sure! Here are some facts about the user.');

    const result = await captureFacts({
      userId,
      turns: [{ userMessage: turn.user, assistantReply: turn.assistant }],
      blockedCategories: [],
      spendMessageId: turn.user.id,
    });

    expect(result).toMatchObject({ type: 'error', code: 'fact_extraction_unreadable' });
    expect(await factsOf(userId)).toEqual([]);
    // The call still cost tokens, and the cost is still recorded.
    expect((await costsOf(turn.user.id)).map((cost) => cost.kind)).toEqual(['fact_extraction']);
  });
});

describe('segmentTurns', () => {
  it('pairs the live Turns between the segment start and its Boundary arrival', async () => {
    const { threadId } = await createUserAndThread();
    const first = await addTurn(threadId, 'one');
    const abandoned = await addTurn(threadId, 'two');
    const third = await addTurn(threadId, 'three', '');
    const boundary = await insertMessage({ threadId, role: 'user', content: 'four' });
    const rows = [first.user, first.assistant, abandoned.user, abandoned.assistant].concat([
      third.user,
      third.assistant,
      boundary,
    ]);
    const withAbandoned = rows.map((row) =>
      row.id === abandoned.user.id || row.id === abandoned.assistant.id
        ? { ...row, abandoned: true }
        : row,
    );

    const turns = segmentTurns(withAbandoned, first.user.id, boundary.id);

    expect(turns.map((turn) => turn.userMessage.content)).toEqual(['one', 'three']);
    expect(turns[0]?.assistantReply?.id).toBe(first.assistant.id);
    // An empty reply is no reply.
    expect(turns[1]?.assistantReply).toBeNull();
  });
});

describe('captureClosedSegments', () => {
  it('captures a closed segment once and marks it', async () => {
    const { userId, threadId, segmentId } = await threadWithClosedSegment([
      'I love hiking in the Alps',
    ]);

    await captureClosedSegments({ userId, threadId });
    const extractions = mock.memory.extractionCount();
    await captureClosedSegments({ userId, threadId });

    expect(await capturedAt(segmentId)).not.toBeNull();
    expect(mock.memory.extractionCount()).toBe(extractions);
    expect((await factsOf(userId)).map((fact) => fact.content)).toEqual([
      'The user loves hiking in the Alps.',
    ]);
  });

  it('owes a segment again once the arrival that closed it is abandoned', async () => {
    const { userId, threadId, boundary, segmentId } = await threadWithClosedSegment([
      'I love hiking in the Alps',
    ]);
    await captureClosedSegments({ userId, threadId });
    expect(await capturedAt(segmentId)).not.toBeNull();

    // An edit abandons the Boundary arrival; the fork stays on topic, so
    // the segment is open again and nothing is owed yet.
    await setMessagesAbandoned({ messageIds: [boundary.id], abandoned: true });
    await addTurn(threadId, 'I work as a carpenter');
    await captureClosedSegments({ userId, threadId });
    expect(await capturedAt(segmentId)).toBeNull();

    const reclosing = await insertMessage({ threadId, role: 'user', content: 'Another topic' });
    await insertSegmentDriftLog({
      segmentId,
      messageId: reclosing.id,
      modelId: EMBEDDING_MODEL_ID,
      verdict: 'fire',
      fireChannel: 'immediate',
    });
    await captureClosedSegments({ userId, threadId });

    expect(await capturedAt(segmentId)).not.toBeNull();
    expect((await factsOf(userId)).map((fact) => fact.content)).toEqual([
      'The user loves hiking in the Alps.',
      'The user works as a carpenter.',
    ]);
  });

  it('marks the segment without gathering anything while memory is off', async () => {
    const { userId, threadId, segmentId } = await threadWithClosedSegment(['I love jazz']);
    await updateUserSettings({ userId, patch: { memoryEnabled: false } });

    await captureClosedSegments({ userId, threadId });

    expect(await capturedAt(segmentId)).not.toBeNull();
    expect(await factsOf(userId)).toEqual([]);
  });

  it('leaves a failed segment owed so the next pass retries it', async () => {
    const { userId, threadId, segmentId } = await threadWithClosedSegment(['I love jazz']);
    mock.memory.failExtractions();

    await captureClosedSegments({ userId, threadId });
    expect(await capturedAt(segmentId)).toBeNull();

    mock.memory.clearFailures();
    await captureClosedSegments({ userId, threadId });
    expect(await capturedAt(segmentId)).not.toBeNull();
    expect(await factsOf(userId)).toHaveLength(1);
  });
});

describe('Seed', () => {
  async function storeFact(userId: string, content: string, overrides: object = {}) {
    const fact = await insertUserFact({
      userId,
      content,
      category: 'preference',
      subject: 'user',
      predicate: null,
      object: null,
      embedding: buildMockEmbedding(content),
      modelId: EMBEDDING_MODEL_ID,
      sourceMessageId: null,
      validAt: new Date('2026-09-01T00:00:00Z'),
    });
    if (Object.keys(overrides).length > 0) {
      await db.updateTable('userFacts').set(overrides).where('id', '=', fact.id).execute();
    }
  }

  it('renders dated bullets newest first and stops at the token budget', () => {
    const facts = Array.from({ length: 50 }, (_, index) => ({
      content: `The user owns plant number ${index}.`,
      category: 'other' as const,
      validAt: new Date('2026-09-01T00:00:00Z'),
    }));

    const rendered = renderedSeedOrNull(facts, 120);

    expect(rendered).not.toBeNull();
    expect(rendered?.lines[0]).toEqual({
      category: 'other',
      text: '- 2026-09-01: The user owns plant number 0.',
    });
    expect(rendered?.factCount).toBeLessThan(50);
    expect(renderedSeedOrNull([])).toBeNull();
  });

  it('seeds a fresh Thread with current, unsuppressed, unblocked Facts', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    await storeFact(userId, 'The user loves jazz.');
    await storeFact(userId, 'The user hides this.', { suppressed: true });
    await storeFact(userId, 'The user used to live in Oslo.', { invalidAt: new Date() });
    await storeFact(userId, 'The user password is hunter2.', { category: 'credentials' });

    const thread = await createThread({ userId });
    const prompt = await assembledSystemPrompt({
      userId,
      threadId: thread.id,
      basePrompt: 'Base.',
    });

    expect(prompt).toContain('Base.\n\nWhat you know about the user');
    expect(prompt).toContain('The user loves jazz.');
    expect(prompt).not.toContain('hides this');
    expect(prompt).not.toContain('Oslo');
    expect(prompt).not.toContain('hunter2');
  });

  it('drops a category blocked after the Seed froze from Threads already open', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    await storeFact(userId, 'The user loves jazz.');
    await storeFact(userId, 'The user lives in Lisbon.', { category: 'location' });
    const thread = await createThread({ userId });

    await updateUserSettings({
      userId,
      patch: { memoryBlockedCategories: ['credentials', 'location'] },
    });
    const prompt = await assembledSystemPrompt({ userId, threadId: thread.id, basePrompt: 'B' });

    expect(prompt).toContain('The user loves jazz.');
    expect(prompt).not.toContain('Lisbon');
  });

  it('keeps the Seed byte-stable while the Memory changes underneath it', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    await storeFact(userId, 'The user loves jazz.');
    const thread = await createThread({ userId });
    const before = await assembledSystemPrompt({ userId, threadId: thread.id, basePrompt: 'B' });

    await storeFact(userId, 'The user plays chess.');

    expect(await assembledSystemPrompt({ userId, threadId: thread.id, basePrompt: 'B' })).toBe(
      before,
    );
  });

  it('writes no Seed for an empty Memory and stops injecting while memory is off', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const empty = await createThread({ userId });
    expect(await assembledSystemPrompt({ userId, threadId: empty.id, basePrompt: 'B' })).toBe('B');

    await storeFact(userId, 'The user loves jazz.');
    const seeded = await createThread({ userId });
    await updateUserSettings({ userId, patch: { memoryEnabled: false } });
    expect(await assembledSystemPrompt({ userId, threadId: seeded.id, basePrompt: 'B' })).toBe('B');
  });
});
