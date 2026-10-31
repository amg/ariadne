import { db } from '@db/db';
import { recordMessageEmbedding } from '@queries/messageEmbeddings/recordMessageEmbedding';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { foldTurnOfReply, runLiveGate } from '@services/threadAnalysis';
import { DEFAULT_USER_ID } from '@services/userService';
import { expect } from 'vitest';

/**
 * Grows Threads for Drift gate tests the way a live chat grows them, and
 * reads back what the gate stored. Every text is long enough that the
 * gate never asks for a rewrite.
 */

const PAD =
  ' consider every practical detail carefully before you answer this, accounting for common edge' +
  ' cases, and explain your reasoning step by step so a beginner can follow along clearly';

export async function newThread(title: string) {
  await insertUserIfNotExists({ id: DEFAULT_USER_ID });
  const { id } = await insertThread({ userId: DEFAULT_USER_ID, title });
  return id;
}

export async function arrive({ threadId, text }: { threadId: string; text: string }) {
  const arrival = await insertMessage({ threadId, role: 'user', content: `${text}${PAD}` });
  return arrival.id;
}

export async function reply({ threadId, text }: { threadId: string; text: string }) {
  const answer = await insertMessage({ threadId, role: 'assistant', content: `${text}${PAD}` });
  return answer.id;
}

/** Judges one arrival the way the queue's judgment does: that arrival is the target. */
export async function judge({ threadId, arrivalId }: { threadId: string; arrivalId: string }) {
  const judged = await runLiveGate({ threadId, upToMessageId: arrivalId, mode: 'heuristic' });
  expect(judged.type).toBe('success');
}

/** Folds one completed Turn the way the queue's fold does. */
export async function foldJob({ threadId, replyId }: { threadId: string; replyId: string }) {
  const folded = await foldTurnOfReply({ threadId, replyMessageId: replyId, mode: 'heuristic' });
  expect(folded.type).toBe('success');
}

/** One live exchange: the arrival is judged before its reply lands, and the fold job may follow. */
export async function exchange({
  threadId,
  user,
  assistant,
  runFoldJob,
}: {
  threadId: string;
  user: string;
  assistant: string;
  runFoldJob: boolean;
}) {
  const arrivalId = await arrive({ threadId, text: user });
  await judge({ threadId, arrivalId });
  const replyId = await reply({ threadId, text: assistant });
  if (runFoldJob) await foldJob({ threadId, replyId });
  return { arrivalId, replyId };
}

/** Exchanges on distinct subjects: the mock embeds them far apart, so each one fires. */
export async function pivots({
  threadId,
  from,
  count,
  runFoldJob,
}: {
  threadId: string;
  from: number;
  count: number;
  runFoldJob: boolean;
}) {
  for (let index = from; index < from + count; index += 1) {
    await exchange({
      threadId,
      user: `question ${index} about subject ${index}`,
      assistant: `answer ${index}`,
      runFoldJob,
    });
  }
}

/** Exchanges on one topic: the mock embeds them close together, so they pass. */
export async function onTopic({
  threadId,
  from,
  count,
  runFoldJob,
}: {
  threadId: string;
  from: number;
  count: number;
  runFoldJob: boolean;
}) {
  const exchanges: Awaited<ReturnType<typeof exchange>>[] = [];
  for (let index = from; index < from + count; index += 1) {
    exchanges.push(
      await exchange({
        threadId,
        user: `sourdough question ${index} TOPIC:sourdough`,
        assistant: `sourdough answer ${index} TOPIC:sourdough`,
        runFoldJob,
      }),
    );
  }
  return exchanges;
}

/** Stores a Message's embedding before the gate reaches it, so the gate reads this vector. */
export async function storeVector({ messageId, vector }: { messageId: string; vector: number[] }) {
  await recordMessageEmbedding({ messageId, embedding: vector, modelId: EMBEDDING_MODEL_ID });
}

/** The verdicts, segments and checkpoints stored for the Thread's live Messages. */
async function storedJudgments(threadId: string) {
  const [verdicts, segments, states, folds] = await Promise.all([
    db
      .selectFrom('analysis.segmentDriftLogs as l')
      .innerJoin('chat.messages as m', 'm.id', 'l.messageId')
      .innerJoin('analysis.threadSegments as s', 's.id', 'l.segmentId')
      .where('m.threadId', '=', threadId)
      .where('m.abandoned', '=', false)
      .select([
        'l.messageId',
        's.startMessageId as segmentStartMessageId',
        'l.verdict',
        'l.fireChannel',
        'l.slowDriftStartMessageId',
        'l.driftP',
        'l.mu',
        'l.sigma',
        'l.zScore',
        'l.immediateThreshold',
      ])
      .orderBy('m.createdAt asc')
      .execute(),
    db
      .selectFrom('analysis.threadSegments')
      .where('threadId', '=', threadId)
      .select('startMessageId')
      .orderBy('startMessageId asc')
      .execute(),
    db
      .selectFrom('analysis.arrivalJudgmentStates as j')
      .innerJoin('chat.messages as m', 'm.id', 'j.messageId')
      .where('m.threadId', '=', threadId)
      .where('m.abandoned', '=', false)
      .select([
        'j.messageId',
        'j.baselineCount',
        'j.baselineMean',
        'j.baselineM2',
        'j.patrolCount',
        'j.patrolSum',
        'j.patrolCumulative',
        'j.patrolLowWater',
        'j.patrolLowWaterMessageId',
      ])
      .orderBy('m.createdAt asc')
      .execute(),
    db
      .selectFrom('analysis.turnFolds as f')
      .innerJoin('chat.messages as m', 'm.id', 'f.messageId')
      .innerJoin('analysis.threadSegments as s', 's.id', 'f.segmentId')
      .where('m.threadId', '=', threadId)
      .where('m.abandoned', '=', false)
      .select([
        'f.messageId',
        's.startMessageId as segmentStartMessageId',
        'f.gravitySum',
        'f.anchorSum',
        'f.anchorCount',
        'f.completedTurns',
      ])
      .orderBy('m.createdAt asc')
      .execute(),
  ]);
  return { verdicts, segments, states, folds };
}

/**
 * Wipes every verdict, segment and checkpoint of the Thread, keeping its
 * stored embeddings and rewrites, and judges every live arrival again in
 * one pass. Returns what that pass stored.
 */
async function rejudgeFromFirstArrival(threadId: string) {
  const messageIds = db.selectFrom('chat.messages').select('id').where('threadId', '=', threadId);
  await db.deleteFrom('analysis.turnFolds').where('messageId', 'in', messageIds).execute();
  await db
    .deleteFrom('analysis.arrivalJudgmentStates')
    .where('messageId', 'in', messageIds)
    .execute();
  await db.deleteFrom('analysis.segmentDriftLogs').where('messageId', 'in', messageIds).execute();
  await db.deleteFrom('analysis.threadSegments').where('threadId', '=', threadId).execute();
  expect((await runLiveGate({ threadId, mode: 'heuristic' })).type).toBe('success');
  return storedJudgments(threadId);
}

/**
 * Expects the Thread's stored judgments to equal those of its live chain
 * judged again from the first arrival, and returns them.
 */
export async function expectSameAsRejudged(threadId: string) {
  const live = await storedJudgments(threadId);
  expect(live.verdicts.length).toBeGreaterThan(0);
  expect(await rejudgeFromFirstArrival(threadId)).toEqual(live);
  return live;
}
