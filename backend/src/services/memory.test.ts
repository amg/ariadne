import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import type { FactCategory } from '@db/types';
import { captureProgressOf } from '@queries/memoryCaptureProgress/upsertCaptureProgress';
import { insertMessage } from '@queries/messages/insertMessage';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { insertSegmentDriftLog } from '@queries/segmentDriftLogs/insertSegmentDriftLog';
import { insertThreadSegment } from '@queries/threadSegments/insertThreadSegment';
import { listThreadSegmentsByThread } from '@queries/threadSegments/listThreadSegmentsByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserFact } from '@queries/userFacts/insertUserFact';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  EMBEDDING_MODEL_ID,
  buildFactExtractionPrompt,
  factExtractionSystemPrompt,
} from '@services/aiService';
import { parseFactCandidates } from '@services/aiService/extractFacts';
import { parseFactDuplicateLabel } from '@services/aiService/judgeFactDuplicate';
import {
  assembledSystemPrompt,
  captureSegment,
  captureUnreadTurns,
  editFactContent,
  factsNamedIn,
  namesInFact,
  readFacts,
  renderedSeedOrNull,
  segmentTurns,
} from '@services/memory';
import { updateUserSettings } from '@services/settingsService';
import { createThread } from '@services/threadService';
import { memoryOff, memoryOn } from '@test/memory';
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

async function addTurn(threadId: string, userText: string, assistantText = 'Noted.') {
  const user = await insertMessage({ threadId, role: 'user', content: userText });
  const assistant = await insertMessage({ threadId, role: 'assistant', content: assistantText });
  return { user, assistant };
}

async function factsOf(userId: string) {
  return db
    .selectFrom('memory.userFacts')
    .select(['content', 'category', 'predicate', 'sourceMessageId', 'suppressed', 'validAt'])
    .where('userId', '=', userId)
    .orderBy('createdAt', 'asc')
    .execute();
}

async function costsOf(messageId: string) {
  return db
    .selectFrom('billing.messageSideCosts')
    .select(['kind', 'promptTokens', 'completionTokens'])
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
    .selectFrom('analysis.threadSegments')
    .select('id')
    .where('startMessageId', '=', boundary.id)
    .executeTakeFirstOrThrow();
  return { userId, threadId, turns, boundary, segmentId: segment.id, secondSegmentId: second.id };
}

async function capturedThrough(segmentId: string) {
  return captureProgressOf(segmentId);
}

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
    await db.updateTable('memory.userFacts').set(overrides).where('id', '=', fact.id).execute();
  }
  return fact;
}

/** What a read found, without the vectors. */
function readOutcome(result: Awaited<ReturnType<typeof readFacts>>) {
  if (result.type !== 'success') throw new Error(`read failed: ${result.code}`);
  return result.data.map(({ id, row, replacesFactId }) => ({
    id,
    content: row.content,
    category: row.category,
    predicate: row.predicate,
    sourceMessageId: row.sourceMessageId,
    suppressed: row.suppressed,
    validAt: row.validAt,
    replacesFactId,
  }));
}

describe('readFacts', () => {
  it('reads Facts with their source Turn, records the spend, and stores no Fact', async () => {
    const { userId, threadId } = await createUserAndThread();
    const first = await addTurn(threadId, 'I love hiking in the Alps');
    const second = await addTurn(threadId, 'I work as a carpenter');

    const result = await readFacts({
      userId,
      turns: [
        { userMessage: first.user, assistantReply: first.assistant },
        { userMessage: second.user, assistantReply: second.assistant },
      ],
      blockedCategories: [],
      spendMessageId: second.user.id,
      capturedThroughAt: null,
    });

    expect(readOutcome(result)).toEqual([
      {
        id: expect.any(String),
        content: 'The user loves hiking in the Alps.',
        category: 'preference',
        predicate: 'loves',
        sourceMessageId: first.user.id,
        suppressed: false,
        validAt: null,
        replacesFactId: null,
      },
      {
        id: expect.any(String),
        content: 'The user works as a carpenter.',
        category: 'work',
        predicate: 'works',
        sourceMessageId: second.user.id,
        suppressed: false,
        validAt: null,
        replacesFactId: null,
      },
    ]);
    expect(await factsOf(userId)).toEqual([]);
    const costs = await costsOf(second.user.id);
    expect(costs.map((cost) => cost.kind)).toEqual(['fact_embedding', 'fact_extraction']);
  });

  it('attributes facts strictly to user messages and ignores statements in assistant replies', async () => {
    const { userId, threadId } = await createUserAndThread();
    const turn = await addTurn(
      threadId,
      'I love reading books',
      'I love playing chess and I work as a doctor.',
    );

    const read = await readFacts({
      userId,
      turns: [{ userMessage: turn.user, assistantReply: turn.assistant }],
      blockedCategories: [],
      spendMessageId: turn.user.id,
      capturedThroughAt: null,
    });

    const facts = readOutcome(read);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      content: 'The user loves reading books.',
      sourceMessageId: turn.user.id,
    });
    expect(facts[0]?.sourceMessageId).not.toBe(turn.assistant.id);
  });

  it('replaces a Fact said again, keeping its suppression, without a duplicate check', async () => {
    const { userId, threadId } = await createUserAndThread();
    const known = await storeFact(userId, 'The user loves hiking in the Alps.', {
      suppressed: true,
    });
    const turn = await addTurn(threadId, 'I love hiking in the Alps');
    const input = {
      userId,
      turns: [{ userMessage: turn.user, assistantReply: turn.assistant }],
      blockedCategories: [],
      spendMessageId: turn.user.id,
      capturedThroughAt: null,
    };
    const checksBefore = mock.memory.duplicateCheckCount();

    const read = await readFacts(input);

    expect(readOutcome(read)).toMatchObject([
      { content: 'The user loves hiking in the Alps.', suppressed: true, replacesFactId: known.id },
    ]);
    expect(mock.memory.duplicateCheckCount()).toBe(checksBefore);
    const once = (await costsOf(turn.user.id)).find((c) => c.kind === 'fact_extraction');

    // A repeated read adds its spend to the same rows instead of replacing them.
    await readFacts(input);
    const twice = (await costsOf(turn.user.id)).find((c) => c.kind === 'fact_extraction');
    expect(twice?.promptTokens).toBe(2 * (once?.promptTokens ?? 0));
  });

  it('checks each candidate against the ones read before it', async () => {
    const { userId, threadId } = await createUserAndThread();
    const first = await addTurn(threadId, 'I love jazz');
    const again = await addTurn(threadId, 'I love jazz');

    const read = await readFacts({
      userId,
      turns: [
        { userMessage: first.user, assistantReply: first.assistant },
        { userMessage: again.user, assistantReply: again.assistant },
      ],
      blockedCategories: [],
      spendMessageId: again.user.id,
      capturedThroughAt: null,
    });

    const [said, saidAgain] = readOutcome(read);
    expect(said).toMatchObject({ sourceMessageId: first.user.id, replacesFactId: null });
    expect(saidAgain).toMatchObject({ sourceMessageId: again.user.id, replacesFactId: said?.id });
  });

  it('drops candidates in blocked categories', async () => {
    const { userId, threadId } = await createUserAndThread();
    const turn = await addTurn(threadId, 'I love jazz');
    const other = await addTurn(threadId, 'I live in Lisbon');

    const read = await readFacts({
      userId,
      turns: [
        { userMessage: turn.user, assistantReply: turn.assistant },
        { userMessage: other.user, assistantReply: other.assistant },
      ],
      blockedCategories: ['preference'],
      spendMessageId: other.user.id,
      capturedThroughAt: null,
    });

    expect(readOutcome(read).map((fact) => fact.category)).toEqual(['location']);
  });

  it('fails when the extraction reply is unreadable, still recording its spend', async () => {
    const { userId, threadId } = await createUserAndThread();
    const turn = await addTurn(threadId, 'I love jazz');
    mock.memory.forceExtraction('Sure! Here are some facts about the user.');

    const result = await readFacts({
      userId,
      turns: [{ userMessage: turn.user, assistantReply: turn.assistant }],
      blockedCategories: [],
      spendMessageId: turn.user.id,
      capturedThroughAt: null,
    });

    expect(result).toMatchObject({ type: 'error', code: 'fact_extraction_unreadable' });
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

    const result = await readFacts({
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
    expect(readOutcome(result)).toMatchObject([
      { content: 'The user works as a carpenter.', sourceMessageId: second.user.id },
    ]);
  });

  it('flags older turns as context in the extraction prompt', () => {
    const prompt = buildFactExtractionPrompt({
      turns: [
        { date: new Date('2026-10-01T10:00:00Z'), userText: 'older', assistantText: null },
        { date: new Date('2026-10-02T10:00:00Z'), userText: 'newer', assistantText: null },
      ],
      contextCount: 1,
    });

    expect(prompt).toContain('Extract facts only from turns marked [NEW]');
    expect(prompt).toContain('Turn 1 [CONTEXT]');
    expect(prompt).toContain('Turn 2 [NEW]');
  });

  // A "Never extract \u2026 credentials" line ahead of the turns made the memory
  // model return no facts at all for whole conversations; as one rule among
  // the others it filters only what it names.
  it('states blocked categories among the system rules, not ahead of the turns', () => {
    const prompt = buildFactExtractionPrompt({
      turns: [{ date: new Date('2026-10-01T10:00:00Z'), userText: 'hi', assistantText: null }],
    });
    const system = factExtractionSystemPrompt(['credentials']);

    expect(prompt).not.toContain('credentials');
    expect(system).toMatch(/^You extract durable facts about the user/);
    expect(system).toMatch(
      /\n- Leave out any fact whose category would be one of: credentials\.\n/,
    );
    expect(factExtractionSystemPrompt([])).not.toContain('Leave out any fact');
  });

  // A segment opening on "he and Kuro" has no word saying what Kuro is; read
  // alone, the memory model guessed dogs.
  it('reads the turns with the known Facts that name what they mention', async () => {
    const { userId, threadId } = await createUserAndThread();
    await storeFact(userId, 'The user owns a black rabbit named Kuro.');
    await storeFact(userId, 'The user lives in New York.');
    await storeFact(userId, 'The user owns a cat named Kuro-chan.');
    await storeFact(userId, "The user's rabbit Kuro bit the vet.", { suppressed: true });
    await storeFact(userId, "The user's PIN for Kuro's microchip is 4821.", {
      category: 'credentials',
    });
    const turn = await addTurn(threadId, 'he and kuro were born in march', 'How lovely!');

    await readFacts({
      userId,
      turns: [{ userMessage: turn.user, assistantReply: turn.assistant }],
      blockedCategories: ['credentials'],
      spendMessageId: turn.user.id,
      capturedThroughAt: null,
    });

    const prompt = mock.memory.lastExtractionPrompt() ?? '';
    const known = prompt.slice(0, prompt.indexOf('Turn 1'));
    expect(known).toContain('Already known about the user');
    expect(known).toContain('- The user owns a black rabbit named Kuro.');
    expect(known).not.toContain('New York');
    expect(known).not.toContain('bit the vet');
    expect(known).not.toContain('4821');
  });

  it('sends no known-Facts section when the turns name nothing the Memory holds', async () => {
    const { userId, threadId } = await createUserAndThread();
    await storeFact(userId, 'The user owns a black rabbit named Kuro.');
    const turn = await addTurn(threadId, 'I love jazz');

    await readFacts({
      userId,
      turns: [{ userMessage: turn.user, assistantReply: turn.assistant }],
      blockedCategories: [],
      spendMessageId: turn.user.id,
      capturedThroughAt: null,
    });

    expect(mock.memory.lastExtractionPrompt()).toMatch(/^Turn 1 /);
  });
});

describe('parseFactCandidates', () => {
  it('keeps names as written, with one marker for the user', () => {
    const reply = JSON.stringify({
      facts: [
        {
          turn: 1,
          content: "The user's rabbit Kuro lives in New York.",
          subject: 'Kuro',
          predicate: 'lives in',
          object: 'New York',
          category: 'other',
        },
        {
          turn: 1,
          content: 'The user loves rabbits.',
          subject: 'User',
          predicate: 'loves',
          object: 'rabbits',
          category: 'preference',
        },
      ],
    });

    expect(parseFactCandidates(reply, 1)).toMatchObject([
      { subject: 'Kuro', predicate: 'lives_in', object: 'New York' },
      { subject: 'user', predicate: 'loves', object: 'rabbits' },
    ]);
  });
});

describe('parseFactDuplicateLabel', () => {
  it('reads which known Fact the candidate is about, or none', () => {
    expect(parseFactDuplicateLabel('SAME 2', 3)).toEqual({ type: 'same', knownIndex: 1 });
    expect(parseFactDuplicateLabel('same 1.', 1)).toEqual({ type: 'same', knownIndex: 0 });
    expect(parseFactDuplicateLabel('NEW', 3)).toEqual({ type: 'new' });
    expect(parseFactDuplicateLabel('SAME 4', 3)).toBeNull();
    expect(parseFactDuplicateLabel('SAME', 3)).toBeNull();
    expect(parseFactDuplicateLabel('maybe', 3)).toBeNull();
  });
});

describe('factsNamedIn', () => {
  it('takes the names a Fact sentence capitalises, past its opening word', () => {
    expect(namesInFact("The user's rabbit Kuro's vet is in New York.")).toEqual([
      'kuro',
      'new york',
    ]);
    expect(namesInFact('The user loves rabbits.')).toEqual([]);
    expect(namesInFact('The user visited Łódź with Zoë.')).toEqual(['łódź', 'zoë']);
  });

  it('matches a name in any case, as whole words only', () => {
    const facts = [
      'The user owns a rabbit named Kuro.',
      'The user travels to New York for work.',
      'The user admires Kurosawa.',
    ];

    expect(factsNamedIn(facts, "kuro's ears and NEW  YORK")).toEqual([
      'The user owns a rabbit named Kuro.',
      'The user travels to New York for work.',
    ]);
    expect(factsNamedIn(facts, 'a new yorker met kurosawa')).toEqual([
      'The user admires Kurosawa.',
    ]);
    expect(factsNamedIn(facts, 'went to york')).toEqual([]);
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

describe('captureSegment', () => {
  it('captures a closed segment once and marks it', async () => {
    const { userId, threadId, segmentId } = await threadWithClosedSegment([
      'I love hiking in the Alps',
    ]);

    const first = await captureSegment({ userId, threadId, segmentId });
    const extractions = mock.memory.extractionCount();
    const second = await captureSegment({ userId, threadId, segmentId });

    expect(first).toMatchObject({ memoryEnabled: true, owed: 1, failed: 0, added: 1 });
    expect(second).toMatchObject({ owed: 0, added: 0 });
    expect(await capturedThrough(segmentId)).not.toBeNull();
    expect(mock.memory.extractionCount()).toBe(extractions);
    expect((await factsOf(userId)).map((fact) => fact.content)).toEqual([
      'The user loves hiking in the Alps.',
    ]);
  });

  it('reopens a segment whose closer dies, and reads only the later Turns at its next cut', async () => {
    const { userId, threadId, boundary, segmentId } = await threadWithClosedSegment([
      'I love hiking in the Alps',
    ]);
    await captureSegment({ userId, threadId, segmentId });
    expect(await capturedThrough(segmentId)).not.toBeNull();
    const extractions = mock.memory.extractionCount();

    // The edit abandons the arrival that closed the segment, and with it the
    // segment that arrival opened. The first segment draws Turns again, so
    // it owes nothing until its next cut.
    await setMessagesAbandoned({ messageIds: [boundary.id], abandoned: true });
    expect(await listThreadSegmentsByThread({ threadId, modelId: EMBEDDING_MODEL_ID })).toEqual([
      expect.objectContaining({ id: segmentId }),
    ]);
    await addTurn(threadId, 'I work as a carpenter');
    await captureSegment({ userId, threadId, segmentId });

    expect(mock.memory.extractionCount()).toBe(extractions);

    const reclosing = await insertMessage({ threadId, role: 'user', content: 'Another topic' });
    await insertSegmentDriftLog({
      segmentId,
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
    await captureSegment({ userId, threadId, segmentId });

    // The hiking Turn sits before the pointer, so only the carpenter Turn is read.
    expect(mock.memory.extractionCount()).toBe(extractions + 1);
    expect((await factsOf(userId)).map((fact) => fact.content)).toEqual([
      'The user loves hiking in the Alps.',
      'The user works as a carpenter.',
    ]);
  });

  it('marks the segment without gathering anything while memory is off', async () => {
    const { userId, threadId, segmentId } = await threadWithClosedSegment(['I love jazz']);
    await updateUserSettings({ userId, patch: { memoryEnabled: false } });

    const report = await captureSegment({ userId, threadId, segmentId });

    expect(report).toMatchObject({ memoryEnabled: false, owed: 0, added: 0 });
    expect(await capturedThrough(segmentId)).not.toBeNull();
    expect(await factsOf(userId)).toEqual([]);
  });

  it('leaves a failed segment owed so the next pass retries it', async () => {
    const { userId, threadId, segmentId } = await threadWithClosedSegment(['I love jazz']);
    mock.memory.failExtractions();

    const failed = await captureSegment({ userId, threadId, segmentId });
    expect(failed).toMatchObject({ owed: 1, failed: 1, added: 0 });
    expect(await capturedThrough(segmentId)).toBeNull();

    mock.memory.clearFailures();
    await captureSegment({ userId, threadId, segmentId });
    expect(await capturedThrough(segmentId)).not.toBeNull();
    expect(await factsOf(userId)).toHaveLength(1);
  });

  it('reads only its own segment, leaving another one owed for its own capture', async () => {
    const { userId, threadId, segmentId, secondSegmentId } = await threadWithClosedSegment([
      'I love jazz',
    ]);
    await insertMessage({ threadId, role: 'assistant', content: 'Noted.' });
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

    const report = await captureSegment({ userId, threadId, segmentId: secondSegmentId });

    expect(report).toMatchObject({ owed: 1, failed: 0 });
    expect(await capturedThrough(secondSegmentId)).not.toBeNull();
    expect(await capturedThrough(segmentId)).toBeNull();
    expect((await factsOf(userId)).map((fact) => fact.content)).not.toContain(
      'The user loves jazz.',
    );
  });

  it('reads nothing from a segment still drawing Turns', async () => {
    const { userId, threadId } = await createUserAndThread();
    const turn = await addTurn(threadId, 'I love jazz');
    const open = await insertThreadSegment({
      threadId,
      startMessageId: turn.user.id,
      modelId: EMBEDDING_MODEL_ID,
    });
    const extractions = mock.memory.extractionCount();

    const report = await captureSegment({ userId, threadId, segmentId: open.id });

    expect(report).toMatchObject({ owed: 0, added: 0 });
    expect(mock.memory.extractionCount()).toBe(extractions);
    expect(await capturedThrough(open.id)).toBeNull();
  });
});

describe('captureUnreadTurns', () => {
  /** A thread with one open segment holding the given turns. */
  async function threadWithOpenSegment(turnTexts: string[]) {
    const { userId, threadId } = await createUserAndThread();
    const turns = [];
    for (const text of turnTexts) turns.push(await addTurn(threadId, text));
    const first = turns[0];
    if (!first) throw new Error('at least one turn');
    const segment = await insertThreadSegment({
      threadId,
      startMessageId: first.user.id,
      modelId: EMBEDDING_MODEL_ID,
    });
    return { userId, threadId, segmentId: segment.id };
  }

  it('reads the open segment, and its later settle reads only what came after', async () => {
    const { userId, threadId, segmentId } = await threadWithOpenSegment([
      'I love hiking in the Alps',
    ]);

    const first = await captureUnreadTurns({ userId, threadId });
    expect(first).toMatchObject({ owed: 1, failed: 0, added: 1 });
    expect(await capturedThrough(segmentId)).not.toBeNull();

    const extractions = mock.memory.extractionCount();
    expect(await captureUnreadTurns({ userId, threadId })).toMatchObject({ owed: 0 });
    expect(mock.memory.extractionCount()).toBe(extractions);

    await addTurn(threadId, 'I work as a carpenter');
    const boundary = await insertMessage({ threadId, role: 'user', content: 'New topic' });
    await insertSegmentDriftLog({
      segmentId,
      messageId: boundary.id,
      modelId: EMBEDDING_MODEL_ID,
      verdict: 'fire',
      fireChannel: 'immediate',
    });
    const settled = await captureSegment({ userId, threadId, segmentId });

    expect(settled).toMatchObject({ owed: 1, added: 1 });
    expect((await factsOf(userId)).map((fact) => fact.content)).toEqual([
      'The user loves hiking in the Alps.',
      'The user works as a carpenter.',
    ]);
  });

  it('stops at the first failed segment, leaving every later one unread', async () => {
    const { userId, threadId, segmentId, secondSegmentId } = await threadWithClosedSegment([
      'I love jazz',
    ]);
    await insertMessage({ threadId, role: 'assistant', content: 'Noted.' });
    const reclosing = await insertMessage({ threadId, role: 'user', content: 'Another topic' });
    await insertSegmentDriftLog({
      segmentId: secondSegmentId,
      messageId: reclosing.id,
      modelId: EMBEDDING_MODEL_ID,
      verdict: 'fire',
      fireChannel: 'immediate',
    });
    const newest = await insertThreadSegment({
      threadId,
      startMessageId: reclosing.id,
      modelId: EMBEDDING_MODEL_ID,
    });
    await insertMessage({ threadId, role: 'assistant', content: 'Noted.' });
    mock.memory.failExtractions();

    const report = await captureUnreadTurns({ userId, threadId });

    expect(report).toMatchObject({ owed: 1, failed: 1, added: 0 });
    for (const id of [segmentId, secondSegmentId, newest.id]) {
      expect(await capturedThrough(id)).toBeNull();
    }
  });

  it('leaves a last arrival still awaiting its reply for later', async () => {
    const { userId, threadId } = await threadWithOpenSegment(['I love jazz']);
    await insertMessage({ threadId, role: 'user', content: 'I work as a carpenter' });

    await captureUnreadTurns({ userId, threadId });
    expect((await factsOf(userId)).map((fact) => fact.content)).toEqual(['The user loves jazz.']);

    await insertMessage({ threadId, role: 'assistant', content: 'Noted.' });
    const answered = await captureUnreadTurns({ userId, threadId });

    expect(answered).toMatchObject({ owed: 1, added: 1 });
    expect((await factsOf(userId)).map((fact) => fact.content)).toEqual([
      'The user loves jazz.',
      'The user works as a carpenter.',
    ]);
  });

  it('reads nothing while memory is off', async () => {
    const { userId, threadId, segmentId } = await threadWithOpenSegment(['I love jazz']);
    await updateUserSettings({ userId, patch: { memoryEnabled: false } });

    const report = await captureUnreadTurns({ userId, threadId });

    expect(report).toMatchObject({ memoryEnabled: false, owed: 0 });
    expect(await capturedThrough(segmentId)).toBeNull();
    expect(await factsOf(userId)).toEqual([]);
  });
});

describe('capture passes on one Thread', () => {
  /** Each spend line of the message, its token counts doubled. */
  async function doubledCostsOf(messageId: string) {
    return (await costsOf(messageId)).map((cost) => ({
      ...cost,
      promptTokens: 2 * (cost.promptTokens ?? 0),
      completionTokens: 2 * (cost.completionTokens ?? 0),
    }));
  }

  it('store the Turns once when two passes read them at once, and record both spends', async () => {
    const { userId, threadId, boundary, segmentId } = await threadWithClosedSegment([
      'I love jazz',
    ]);
    const extractions = mock.memory.extractionCount();

    // The segment capture reads the pointer, then waits on its extraction
    // while the on-demand pass captures the same Turns from start to end.
    const extraction = mock.memory.holdNextExtraction();
    const slow = captureSegment({ userId, threadId, segmentId });
    await extraction.arrived;
    const fast = await captureUnreadTurns({ userId, threadId });
    const bothSpends = await doubledCostsOf(boundary.id);
    extraction.release();
    const slowReport = await slow;

    expect(fast).toMatchObject({ owed: 1, added: 1, failed: 0 });
    expect(slowReport).toMatchObject({ owed: 0, added: 0, replaced: 0, failed: 0 });
    expect(mock.memory.extractionCount()).toBe(extractions + 2);
    expect((await factsOf(userId)).map((fact) => fact.content)).toEqual(['The user loves jazz.']);
    expect(await capturedThrough(segmentId)).toEqual(boundary.createdAt);
    // The two reads were alike, so together they cost twice one of them.
    expect(await costsOf(boundary.id)).toEqual(bothSpends);
  });

  it('store nothing of a pass whose pointer moved on while it read', async () => {
    const { userId, threadId } = await createUserAndThread();
    const opening = await addTurn(threadId, 'I love jazz');
    await insertThreadSegment({
      threadId,
      startMessageId: opening.user.id,
      modelId: EMBEDDING_MODEL_ID,
    });
    await captureUnreadTurns({ userId, threadId });
    await addTurn(threadId, 'I live in Lisbon');

    const extraction = mock.memory.holdNextExtraction();
    const slow = captureUnreadTurns({ userId, threadId });
    await extraction.arrived;
    const fast = await captureUnreadTurns({ userId, threadId });
    extraction.release();

    expect(fast).toMatchObject({ owed: 1, added: 1 });
    expect(await slow).toMatchObject({ owed: 0, added: 0, failed: 0 });
    expect((await factsOf(userId)).map((fact) => fact.content)).toEqual([
      'The user loves jazz.',
      'The user lives in Lisbon.',
    ]);
  });
});

describe('Seed', () => {
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

    const thread = await createThread({ userId, memory: memoryOn });
    const prompt = await assembledSystemPrompt({
      userId,
      threadId: thread.id,
      basePrompt: 'Base.',
      memory: memoryOn,
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
    const thread = await createThread({ userId, memory: memoryOn });

    await updateUserSettings({
      userId,
      patch: { memoryBlockedCategories: ['credentials', 'location'] },
    });
    const prompt = await assembledSystemPrompt({
      userId,
      threadId: thread.id,
      basePrompt: 'B',
      memory: memoryOn,
    });

    expect(prompt).toContain('The user loves jazz.');
    expect(prompt).not.toContain('Lisbon');
  });

  it('keeps the Seed byte-stable while the Memory changes underneath it', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    await storeFact(userId, 'The user loves jazz.');
    const thread = await createThread({ userId, memory: memoryOn });
    const before = await assembledSystemPrompt({
      userId,
      threadId: thread.id,
      basePrompt: 'B',
      memory: memoryOn,
    });

    await storeFact(userId, 'The user plays chess.');

    expect(
      await assembledSystemPrompt({
        userId,
        threadId: thread.id,
        basePrompt: 'B',
        memory: memoryOn,
      }),
    ).toBe(before);
  });

  it('writes no Seed for an empty Memory and stops injecting while memory is off', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    const empty = await createThread({ userId, memory: memoryOn });
    expect(
      await assembledSystemPrompt({
        userId,
        threadId: empty.id,
        basePrompt: 'B',
        memory: memoryOn,
      }),
    ).toBe('B');

    await storeFact(userId, 'The user loves jazz.');
    const seeded = await createThread({ userId, memory: memoryOn });
    await updateUserSettings({ userId, patch: { memoryEnabled: false } });
    expect(
      await assembledSystemPrompt({
        userId,
        threadId: seeded.id,
        basePrompt: 'B',
        memory: memoryOn,
      }),
    ).toBe('B');
  });

  it('writes and reads no Seed in a deployment without Memory', async () => {
    const userId = randomUUID();
    await insertUserIfNotExists({ id: userId });
    await storeFact(userId, 'The user loves jazz.');

    await createThread({ userId, memory: memoryOff });
    const seeded = await createThread({ userId, memory: memoryOn });

    const seeds = await db.selectFrom('memory.threadSeeds').select('threadId').execute();
    expect(seeds.map((seed) => seed.threadId)).toEqual([seeded.id]);
    expect(
      await assembledSystemPrompt({
        userId,
        threadId: seeded.id,
        basePrompt: 'B',
        memory: memoryOff,
      }),
    ).toBe('B');
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
      .selectFrom('memory.userFacts')
      .select(['content', 'invalidAt'])
      .where('id', '=', factId)
      .executeTakeFirstOrThrow();
  }

  it('stays filed where it was when the sentence still supports it', async () => {
    const { userId } = await createUserAndThread();
    const fact = await storedFact(userId, {
      content: "Maria is the user's sister.",
      category: 'relationships',
      subject: 'Maria',
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
        subject: 'Maria',
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
    await db
      .updateTable('memory.userFacts')
      .set({ suppressed: true })
      .where('id', '=', fact.id)
      .execute();

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
