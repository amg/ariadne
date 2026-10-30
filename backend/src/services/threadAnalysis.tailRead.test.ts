import { db, requestDbScope } from '@db/db';
import { listMessageExpansionsByMessageIds } from '@queries/messageExpansions/listMessageExpansionsByMessageIds';
import { insertMessage } from '@queries/messages/insertMessage';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { foldTurnOfReply, runLiveGate } from '@services/threadAnalysis';
import {
  arrive,
  expectSameAsRejudged,
  foldJob,
  judge,
  newThread,
  onTopic,
  reply,
} from '@test/gateThread';
import { useTestDb } from '@test/test-db';
import type { KyselyPlugin } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';

/**
 * A judgment reads only the newest few rows of the live chain, and walks
 * the whole chain again only when the stored checkpoints cannot speak for
 * it. Forks, orphaned arrivals and passes racing an edit, a regenerate or
 * each other must leave the checkpoints such that the next judgment is
 * back on the newest rows.
 */

useTestDb();

let mock: MockInferenceServer;
let savedMockUrl: string | undefined;

beforeAll(async () => {
  savedMockUrl = process.env.MOCK_AI_BASE_URL;
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterEach(() => {
  mock.embeddings.clearFailures();
});

afterAll(async () => {
  process.env.MOCK_AI_BASE_URL = savedMockUrl ?? '';
  await mock.stop();
});

async function liveMessageCount(threadId: string) {
  const rows = await db
    .selectFrom('chat.messages')
    .select('id')
    .where('threadId', '=', threadId)
    .where('abandoned', '=', false)
    .execute();
  return rows.length;
}

/**
 * Judges the arrival and reports whether the pass walked the whole live
 * chain: whether the database sent back at least as many Messages as the
 * Thread holds live.
 */
async function judgeCountingReads({
  threadId,
  arrivalId,
}: {
  threadId: string;
  arrivalId: string;
}) {
  const live = await liveMessageCount(threadId);
  let messages = 0;
  const counting: KyselyPlugin = {
    transformQuery: (args) => args.node,
    transformResult: async (args) => {
      messages += args.result.rows.filter((row) => 'role' in row && 'content' in row).length;
      return args.result;
    },
  };
  const judged = await requestDbScope.run(db.withPlugin(counting), () =>
    runLiveGate({ threadId, upToMessageId: arrivalId, mode: 'heuristic' }),
  );
  expect(judged.type).toBe('success');
  return { walkedChain: messages >= live };
}

/** Expects the arrival's judgment to read only the newest rows. */
async function expectJudgedOnNewestRows({
  threadId,
  arrivalId,
}: {
  threadId: string;
  arrivalId: string;
}) {
  expect((await judgeCountingReads({ threadId, arrivalId })).walkedChain).toBe(false);
}

async function verdictOf(messageId: string) {
  return db
    .selectFrom('analysis.segmentDriftLogs')
    .select('verdict')
    .where('messageId', '=', messageId)
    .executeTakeFirst();
}

async function statesOf(threadId: string) {
  const rows = await db
    .selectFrom('analysis.arrivalJudgmentStates as s')
    .innerJoin('chat.messages as m', 'm.id', 's.messageId')
    .where('m.threadId', '=', threadId)
    .select('s.messageId')
    .execute();
  return rows.map((row) => row.messageId);
}

/**
 * Grows a Thread on one topic with `orphans` live arrivals in a row that
 * never get their reply, as two tabs submitting at once leave them, then
 * keeps the Thread going. Reports, for each judgment from the answered
 * arrival on, whether it walked the whole chain.
 */
async function walksAfterOrphans({ threadId, orphans }: { threadId: string; orphans: number }) {
  await onTopic({ threadId, from: 0, count: 5, runFoldJob: false });
  for (let index = 0; index < orphans; index += 1) {
    const orphan = await arrive({ threadId, text: `sourdough orphan ${index} TOPIC:sourdough` });
    await judge({ threadId, arrivalId: orphan });
  }
  const walks: boolean[] = [];
  let lastReply = '';
  for (let index = 5; index < 11; index += 1) {
    const arrivalId = await arrive({
      threadId,
      text: `sourdough question ${index} TOPIC:sourdough`,
    });
    walks.push((await judgeCountingReads({ threadId, arrivalId })).walkedChain);
    lastReply = await reply({ threadId, text: `sourdough answer ${index} TOPIC:sourdough` });
  }
  await foldJob({ threadId, replyId: lastReply });
  return walks;
}

describe('a judgment reads the newest rows of the live chain', () => {
  it('reads fewer Messages than a long Thread holds', async () => {
    const threadId = await newThread('long');
    await onTopic({ threadId, from: 0, count: 8, runFoldJob: true });

    await expectJudgedOnNewestRows({
      threadId,
      arrivalId: await arrive({ threadId, text: 'sourdough question 8 TOPIC:sourdough' }),
    });
  });

  it('judges every earlier arrival that was never judged', async () => {
    const threadId = await newThread('never judged');
    let target = '';
    for (let index = 0; index < 6; index += 1) {
      target = await arrive({ threadId, text: `sourdough question ${index} TOPIC:sourdough` });
      await reply({ threadId, text: `sourdough answer ${index} TOPIC:sourdough` });
    }
    await judge({ threadId, arrivalId: target });

    const live = await expectSameAsRejudged(threadId);
    expect(live.verdicts).toHaveLength(6);
  });

  it('walks the chain when an arrival before the newest rows lost its verdict', async () => {
    const threadId = await newThread('lost verdict');
    const exchanges = await onTopic({ threadId, from: 0, count: 6, runFoldJob: true });
    const lost = exchanges[1]?.arrivalId;
    if (!lost) throw new Error('expected an exchange');
    await db.deleteFrom('analysis.segmentDriftLogs').where('messageId', '=', lost).execute();

    const arrivalId = await arrive({ threadId, text: 'sourdough question 6 TOPIC:sourdough' });
    expect((await judgeCountingReads({ threadId, arrivalId })).walkedChain).toBe(true);
    expect(await verdictOf(lost)).toBeDefined();
  });

  it('rewrites an unjudged arrival with the exchange before it as context', async () => {
    const threadId = await newThread('context before the newest rows');
    await onTopic({ threadId, from: 0, count: 3, runFoldJob: true });
    // Short and anaphoric, so its rewrite needs the exchange before it.
    const followUp = await insertMessage({
      threadId,
      role: 'user',
      content: 'What about the price of those?',
    });
    await reply({ threadId, text: 'sourdough answer 3 TOPIC:sourdough' });
    await arrive({ threadId, text: 'sourdough question 4 TOPIC:sourdough' });
    await reply({ threadId, text: 'sourdough answer 4 TOPIC:sourdough' });
    await judge({
      threadId,
      arrivalId: await arrive({ threadId, text: 'sourdough question 5 TOPIC:sourdough' }),
    });

    const [expansion] = await listMessageExpansionsByMessageIds({ messageIds: [followUp.id] });
    expect(expansion?.expandOutcome).not.toBe('not_needed');
  });
});

describe('forks and orphans', () => {
  it('walks the chain once after a fork from a Message in the middle, then reads the newest rows', async () => {
    const threadId = await newThread('mid-thread fork');
    const exchanges = await onTopic({ threadId, from: 0, count: 8, runFoldJob: true });
    // Everything from the fifth arrival down is abandoned, and the fork lands after it.
    await setMessagesAbandoned({
      messageIds: exchanges.slice(4).flatMap((row) => [row.arrivalId, row.replyId]),
      abandoned: true,
    });

    const fork = await arrive({ threadId, text: 'sourdough question 4 again TOPIC:sourdough' });
    expect((await judgeCountingReads({ threadId, arrivalId: fork })).walkedChain).toBe(true);
    await foldJob({
      threadId,
      replyId: await reply({ threadId, text: 'sourdough answer 4 again TOPIC:sourdough' }),
    });
    await expectJudgedOnNewestRows({
      threadId,
      arrivalId: await arrive({ threadId, text: 'sourdough question 5 TOPIC:sourdough' }),
    });

    await expectSameAsRejudged(threadId);
  });

  it('walks the chain at most once for an arrival that never got its reply', async () => {
    const threadId = await newThread('orphan');
    const walks = await walksAfterOrphans({ threadId, orphans: 1 });

    expect(walks.filter((walked) => walked).length).toBeLessThanOrEqual(1);
    expect(walks[walks.length - 1]).toBe(false);
    await expectSameAsRejudged(threadId);
  });

  it('walks the chain at most once for several arrivals in a row that never got their reply', async () => {
    const threadId = await newThread('orphans in a row');
    const walks = await walksAfterOrphans({ threadId, orphans: 3 });

    expect(walks.filter((walked) => walked).length).toBeLessThanOrEqual(1);
    expect(walks[walks.length - 1]).toBe(false);
    await expectSameAsRejudged(threadId);
  });
});

describe('passes racing each other, an edit or a regenerate', () => {
  it('keeps the newer arrival’s checkpoint when the older arrival’s pass finishes last', async () => {
    const threadId = await newThread('two tabs');
    await onTopic({ threadId, from: 0, count: 4, runFoldJob: true });
    // Two tabs submitted at once: two adjacent live arrivals.
    const older = await arrive({ threadId, text: 'sourdough question 4 TOPIC:sourdough' });
    const newer = await arrive({ threadId, text: 'sourdough question 5 TOPIC:sourdough' });

    // The older arrival's pass waits on its embedding while the newer's
    // pass judges and commits both arrivals.
    const embedOfOlder = mock.embeddings.holdNext();
    const olderPass = runLiveGate({ threadId, upToMessageId: older, mode: 'heuristic' });
    await embedOfOlder.arrived;
    await judge({ threadId, arrivalId: newer });
    embedOfOlder.release();
    expect((await olderPass).type).toBe('success');

    expect(await statesOf(threadId)).toEqual(expect.arrayContaining([older, newer]));
    await foldJob({
      threadId,
      replyId: await reply({ threadId, text: 'sourdough answer 5 TOPIC:sourdough' }),
    });
    await expectJudgedOnNewestRows({
      threadId,
      arrivalId: await arrive({ threadId, text: 'sourdough question 6 TOPIC:sourdough' }),
    });
    await expectSameAsRejudged(threadId);
  });

  it('stores nothing for an arrival an edit abandoned while it was judged', async () => {
    const threadId = await newThread('edit during judgment');
    await onTopic({ threadId, from: 0, count: 4, runFoldJob: true });
    const edited = await arrive({ threadId, text: 'sourdough question 4 TOPIC:sourdough' });

    // The stale pass has read the chain and waits on the arrival's embedding.
    const embedOfEdited = mock.embeddings.holdNext();
    const stalePass = runLiveGate({ threadId, upToMessageId: edited, mode: 'heuristic' });
    await embedOfEdited.arrived;
    await setMessagesAbandoned({ messageIds: [edited], abandoned: true });
    const fork = await arrive({ threadId, text: 'sourdough question 4 revised TOPIC:sourdough' });
    await judge({ threadId, arrivalId: fork });
    embedOfEdited.release();

    const stale = await stalePass;
    expect(stale.type === 'error' ? stale.code : null).toBe('arrival_not_live');
    expect(await verdictOf(edited)).toBeUndefined();
    await foldJob({
      threadId,
      replyId: await reply({ threadId, text: 'sourdough answer 4 revised TOPIC:sourdough' }),
    });
    await expectJudgedOnNewestRows({
      threadId,
      arrivalId: await arrive({ threadId, text: 'sourdough question 5 TOPIC:sourdough' }),
    });
    await expectSameAsRejudged(threadId);
  });

  it('keeps the live checkpoints when a regenerate lands while the old reply folds', async () => {
    const threadId = await newThread('regenerate during fold');
    await onTopic({ threadId, from: 0, count: 4, runFoldJob: true });
    const [last] = await onTopic({ threadId, from: 4, count: 1, runFoldJob: false });
    if (!last) throw new Error('expected an exchange');

    // The old reply's fold has read the chain and waits on the Turn's embedding.
    const embedOfOldTurn = mock.embeddings.holdNext();
    const oldFold = foldTurnOfReply({
      threadId,
      replyMessageId: last.replyId,
      mode: 'heuristic',
    });
    await embedOfOldTurn.arrived;
    await setMessagesAbandoned({ messageIds: [last.replyId], abandoned: true });
    const fresh = await reply({ threadId, text: 'sourdough answer 4 again TOPIC:sourdough' });
    embedOfOldTurn.release();
    expect((await oldFold).type).toBe('success');

    await foldJob({ threadId, replyId: fresh });
    await expectJudgedOnNewestRows({
      threadId,
      arrivalId: await arrive({ threadId, text: 'sourdough question 5 TOPIC:sourdough' }),
    });
    await expectSameAsRejudged(threadId);
  });
});
