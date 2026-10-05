import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import type { FactCategory, Message } from '@db/types';
import { captureProgressOf } from '@queries/memoryCaptureProgress/upsertCaptureProgress';
import { insertMessage } from '@queries/messages/insertMessage';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { insertSegmentDriftLog } from '@queries/segmentDriftLogs/insertSegmentDriftLog';
import { insertThreadSegment } from '@queries/threadSegments/insertThreadSegment';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserFact } from '@queries/userFacts/insertUserFact';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID, buildFactExtractionPrompt } from '@services/aiService';
import {
  assembledSystemPrompt,
  captureClosedSegments,
  captureFacts,
  editFactContent,
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
    .select(['content', 'category', 'predicate', 'sourceMessageId', 'suppressed', 'validAt'])
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
  const second = await db
    .selectFrom('threadSegments')
    .select('id')
    .where('startMessageId', '=', boundary.id)
    .executeTakeFirstOrThrow();
  return { userId, threadId, turns, boundary, segmentId: segment.id, secondSegmentId: second.id };
}

async function capturedThrough(segmentId: string): Promise<Date | null> {
  return captureProgressOf(segmentId);
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
      capturedThroughAt: null,
    });

    expect(result).toEqual({ type: 'success', data: { added: 2, skippedAsDuplicate: 0 } });
    expect(await factsOf(userId)).toEqual([
      {
        content: 'The user loves hiking in the Alps.',
        category: 'preference',
        predicate: 'loves',
        sourceMessageId: first.user.id,
        suppressed: false,
        validAt: null,
      },
      {
        content: 'The user works as a carpenter.',
        category: 'work',
        predicate: 'works',
        sourceMessageId: second.user.id,
        suppressed: false,
        validAt: null,
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
      capturedThroughAt: null,
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
      capturedThroughAt: null,
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
      capturedThroughAt: null,
    });

    expect(result).toMatchObject({ type: 'error', code: 'fact_extraction_unreadable' });
    expect(await factsOf(userId)).toEqual([]);
    // The call still cost tokens, and the cost is still recorded.
    expect((await costsOf(turn.user.id)).map((cost) => cost.kind)).toEqual(['fact_extraction']);
  });

  it('LOOP-neo1: extracts only turns newer than the last captured point, keeping older ones as context', async () => {
    const { userId, threadId } = await createUserAndThread();
    const first = await addTurn(threadId, 'I love hiking in the Alps');
    const second = await addTurn(threadId, 'I work as a carpenter');

    // The mock db stamps fast inserts with one clock read; give the turns
    // distinct dates so the pointer split is unambiguous.
    const older = new Date('2026-10-01T10:00:00Z');
    const newer = new Date('2026-10-02T10:00:00Z');

    const result = await captureFacts({
      userId,
      turns: [
        {
          userMessage: { ...first.user, createdAt: older },
          assistantReply: { ...first.assistant, createdAt: older },
        },
        {
          userMessage: { ...second.user, createdAt: newer },
          assistantReply: { ...second.assistant, createdAt: newer },
        },
      ],
      blockedCategories: [],
      spendMessageId: second.user.id,
      capturedThroughAt: older,
    });

    // The older turn is context for reading the new one, not a source.
    expect(result).toEqual({ type: 'success', data: { added: 1, skippedAsDuplicate: 0 } });
    expect((await factsOf(userId)).map((fact) => fact.content)).toEqual([
      'The user works as a carpenter.',
    ]);
    expect((await factsOf(userId))[0]?.sourceMessageId).toBe(second.user.id);
  });

  it('flags older turns as context in the extraction prompt', () => {
    const prompt = buildFactExtractionPrompt({
      turns: [
        { date: new Date('2026-10-01T10:00:00Z'), userText: 'older', assistantText: null },
        { date: new Date('2026-10-02T10:00:00Z'), userText: 'newer', assistantText: null },
      ],
      contextCount: 1,
      blockedCategories: [],
    });

    expect(prompt).toContain('Extract facts only from turns marked [NEW]');
    expect(prompt).toContain('Turn 1 [CONTEXT]');
    expect(prompt).toContain('Turn 2 [NEW]');
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

    expect(await capturedThrough(segmentId)).not.toBeNull();
    expect(mock.memory.extractionCount()).toBe(extractions);
    expect((await factsOf(userId)).map((fact) => fact.content)).toEqual([
      'The user loves hiking in the Alps.',
    ]);
  });

  it('keeps old Turns captured when the closer dies; the fork settles at the next cut', async () => {
    const { userId, threadId, boundary, segmentId, secondSegmentId } =
      await threadWithClosedSegment(['I love hiking in the Alps']);
    await captureClosedSegments({ userId, threadId });
    expect(await capturedThrough(segmentId)).not.toBeNull();
    const extractions = mock.memory.extractionCount();

    // The edit abandons the arrival that closed the segment. That cut still
    // stands (the successor segment names it), so nothing is owed again; the
    // fork's Turns settle at the next cut in the chain.
    await setMessagesAbandoned({ messageIds: [boundary.id], abandoned: true });
    await addTurn(threadId, 'I work as a carpenter');
    await captureClosedSegments({ userId, threadId });

    expect(mock.memory.extractionCount()).toBe(extractions); // nothing was re-extracted
    expect((await factsOf(userId)).map((fact) => fact.content)).toEqual([
      'The user loves hiking in the Alps.',
    ]);

    const reclosing = await insertMessage({ threadId, role: 'user', content: 'Another topic' });
    await insertSegmentDriftLog({
      segmentId: secondSegmentId,
      messageId: reclosing.id,
      modelId: EMBEDDING_MODEL_ID,
      verdict: 'fire',
      fireChannel: 'immediate',
    });
    await insertThreadSegment({
      threadId,
      startMessageId: reclosing.id,
      modelId: EMBEDDING_MODEL_ID,
    });
    await captureClosedSegments({ userId, threadId });

    expect(await capturedThrough(secondSegmentId)).not.toBeNull();
    expect((await factsOf(userId)).map((fact) => fact.content)).toEqual([
      'The user loves hiking in the Alps.',
      'The user works as a carpenter.',
    ]);
  });

  it('marks the segment without gathering anything while memory is off', async () => {
    const { userId, threadId, segmentId } = await threadWithClosedSegment(['I love jazz']);
    await updateUserSettings({ userId, patch: { memoryEnabled: false } });

    await captureClosedSegments({ userId, threadId });

    expect(await capturedThrough(segmentId)).not.toBeNull();
    expect(await factsOf(userId)).toEqual([]);
  });

  it('leaves a failed segment owed so the next pass retries it', async () => {
    const { userId, threadId, segmentId } = await threadWithClosedSegment(['I love jazz']);
    mock.memory.failExtractions();

    await captureClosedSegments({ userId, threadId });
    expect(await capturedThrough(segmentId)).toBeNull();

    mock.memory.clearFailures();
    await captureClosedSegments({ userId, threadId });
    expect(await capturedThrough(segmentId)).not.toBeNull();
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
      createdAt: new Date('2026-09-02T00:00:00Z'),
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

  it('dates an unstated Fact with when it was noted', () => {
    const rendered = renderedSeedOrNull([
      {
        content: 'The user loves jazz.',
        category: 'preference',
        validAt: null,
        createdAt: new Date('2026-09-02T08:30:00Z'),
      },
    ]);

    expect(rendered?.lines).toEqual([
      { category: 'preference', text: '- 2026-09-02: The user loves jazz.' },
    ]);
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

describe('editFactContent', () => {
  async function storedFact(
    userId: string,
    fields: {
      content: string;
      category: FactCategory;
      subject: string | null;
      validAt?: Date | null;
      sourceMessageId?: string | null;
    },
  ) {
    return insertUserFact({
      userId,
      predicate: null,
      object: null,
      embedding: buildMockEmbedding(fields.content),
      modelId: EMBEDDING_MODEL_ID,
      validAt: null,
      sourceMessageId: null,
      ...fields,
    });
  }

  async function rowOf(factId: string) {
    return db
      .selectFrom('userFacts')
      .select(['content', 'invalidAt'])
      .where('id', '=', factId)
      .executeTakeFirstOrThrow();
  }

  it('stays filed where it was when the sentence still supports it', async () => {
    const { userId } = await createUserAndThread();
    const fact = await storedFact(userId, {
      content: "Maria is the user's sister.",
      category: 'relationships',
      subject: 'maria',
    });

    const edited = await editFactContent({
      factId: fact.id,
      userId,
      newContent: "Maria is the user's older sister.",
    });

    expect(edited).toMatchObject({
      type: 'success',
      data: {
        content: "Maria is the user's older sister.",
        category: 'relationships',
        subject: 'maria',
      },
    });
    expect((await rowOf(fact.id)).invalidAt).not.toBeNull();
  });

  it('refiles from the new sentence and reads its stated date, keeping suppression and source', async () => {
    const { userId, threadId } = await createUserAndThread();
    const turn = await addTurn(threadId, 'I love jazz');
    const fact = await storedFact(userId, {
      content: 'The user loves jazz.',
      category: 'preference',
      subject: 'user',
      sourceMessageId: turn.user.id,
    });
    await db.updateTable('userFacts').set({ suppressed: true }).where('id', '=', fact.id).execute();

    const edited = await editFactContent({
      factId: fact.id,
      userId,
      newContent: 'The user works as a drummer since 2025-03-01.',
    });

    expect(edited).toMatchObject({
      type: 'success',
      data: {
        category: 'work',
        subject: 'user',
        predicate: 'works',
        validAt: new Date('2025-03-01T00:00:00Z'),
        suppressed: true,
        sourceMessageId: turn.user.id,
      },
    });
  });

  it('drops the old date when the edited sentence states none', async () => {
    const { userId } = await createUserAndThread();
    const fact = await storedFact(userId, {
      content: 'The user lives in Lisbon since 2019-01-01.',
      category: 'location',
      subject: 'user',
      validAt: new Date('2019-01-01T00:00:00Z'),
    });

    const edited = await editFactContent({
      factId: fact.id,
      userId,
      newContent: 'The user lives in Lisbon.',
    });

    expect(edited).toMatchObject({ type: 'success', data: { validAt: null } });
  });

  it('leaves the Fact untouched when the sentence cannot be classified', async () => {
    const { userId } = await createUserAndThread();
    const fact = await storedFact(userId, {
      content: 'The user loves jazz.',
      category: 'preference',
      subject: 'user',
    });
    mock.memory.failClassifications();

    const edited = await editFactContent({
      factId: fact.id,
      userId,
      newContent: 'The user loves blues.',
    });

    expect(edited.type).toBe('error');
    expect(await rowOf(fact.id)).toEqual({ content: 'The user loves jazz.', invalidAt: null });
    expect(await factsOf(userId)).toHaveLength(1);
  });

  it('reports a superseded Fact as not found without calling the model', async () => {
    const { userId } = await createUserAndThread();
    const fact = await storedFact(userId, {
      content: 'The user loves jazz.',
      category: 'preference',
      subject: 'user',
    });
    await editFactContent({ factId: fact.id, userId, newContent: 'The user loves blues.' });
    const calls = mock.memory.classificationCount();

    const again = await editFactContent({
      factId: fact.id,
      userId,
      newContent: 'The user loves soul.',
    });

    expect(again).toMatchObject({ type: 'error', code: 'fact_not_found' });
    expect(mock.memory.classificationCount()).toBe(calls);
  });
});
