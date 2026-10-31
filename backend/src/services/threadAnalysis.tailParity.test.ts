import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import {
  arrive,
  exchange,
  expectSameAsRejudged,
  foldJob,
  judge,
  newThread,
  onTopic,
  pivots,
  reply,
  storeVector,
} from '@test/gateThread';
import { useTestDb } from '@test/test-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';

/**
 * A Thread judged the way a live chat judges it, one arrival at a time
 * with that arrival as the target, must hold the same verdicts, segments
 * and checkpoints as the same live chain judged again from its first
 * arrival.
 */

useTestDb();

let mock: MockInferenceServer;
let savedMockUrl: string | undefined;

beforeAll(async () => {
  savedMockUrl = process.env.MOCK_AI_BASE_URL;
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterAll(async () => {
  process.env.MOCK_AI_BASE_URL = savedMockUrl ?? '';
  await mock.stop();
});

/** A 1,024-wide vector at an angle in one plane, with a small wobble off it. */
function vectorAt({ angle, wobble }: { angle: number; wobble: number }) {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[0] = Math.cos(angle);
  vector[1] = Math.sin(angle);
  vector[2] = wobble;
  return vector;
}

describe('judging one arrival at a time matches judging the live chain again', () => {
  it('holds on a Thread where every arrival fires', async () => {
    const threadId = await newThread('fires, folded by the queue');
    await pivots({ threadId, from: 0, count: 7, runFoldJob: true });

    const live = await expectSameAsRejudged(threadId);
    expect(live.verdicts.filter((row) => row.verdict === 'fire').length).toBe(6);
  });

  it('holds when every Turn is folded by the next judgment instead of the queue', async () => {
    const threadId = await newThread('fires, folded inline');
    await pivots({ threadId, from: 0, count: 6, runFoldJob: false });
    await onTopic({ threadId, from: 6, count: 3, runFoldJob: false });
    const last = await arrive({ threadId, text: 'sourdough question 9 TOPIC:sourdough' });
    await judge({ threadId, arrivalId: last });

    const live = await expectSameAsRejudged(threadId);
    expect(live.verdicts.filter((row) => row.verdict === 'pass').length).toBeGreaterThan(0);
  });

  it('holds across a slow-drift fire', async () => {
    const threadId = await newThread('slow drift');
    // Four Turns in one place, then each Turn turns a little further away:
    // the Anchor distance climbs while each reading stays under the bar.
    for (let index = 0; index < 12; index += 1) {
      const vector = vectorAt({
        angle: index < 4 ? 0 : (index - 3) * 0.1,
        wobble: index % 2 === 0 ? -0.05 : 0.05,
      });
      const arrivalId = await arrive({ threadId, text: `drifting question ${index}` });
      await storeVector({ messageId: arrivalId, vector });
      await judge({ threadId, arrivalId });
      const replyId = await reply({ threadId, text: `drifting answer ${index}` });
      await storeVector({ messageId: replyId, vector });
      await foldJob({ threadId, replyId });
    }

    const live = await expectSameAsRejudged(threadId);
    const slow = live.verdicts.filter((row) => row.fireChannel === 'slow');
    expect(slow).toHaveLength(1);
    expect(slow[0]?.slowDriftStartMessageId).not.toBeNull();
  });

  it('holds across an edit of the newest arrival', async () => {
    const threadId = await newThread('edit fork');
    await onTopic({ threadId, from: 0, count: 4, runFoldJob: true });
    const edited = await exchange({
      threadId,
      user: 'sourdough question 4 TOPIC:sourdough',
      assistant: 'sourdough answer 4 TOPIC:sourdough',
      runFoldJob: true,
    });
    // An edit abandons the arrival and its reply, then adds the fork after them.
    await setMessagesAbandoned({
      messageIds: [edited.arrivalId, edited.replyId],
      abandoned: true,
    });
    await onTopic({ threadId, from: 5, count: 3, runFoldJob: true });

    await expectSameAsRejudged(threadId);
  });

  it('holds across a regenerated reply', async () => {
    const threadId = await newThread('regenerate');
    await onTopic({ threadId, from: 0, count: 4, runFoldJob: true });
    const regenerated = await exchange({
      threadId,
      user: 'sourdough question 4 TOPIC:sourdough',
      assistant: 'sourdough answer 4 TOPIC:sourdough',
      runFoldJob: true,
    });
    await setMessagesAbandoned({ messageIds: [regenerated.replyId], abandoned: true });
    await foldJob({
      threadId,
      replyId: await reply({ threadId, text: 'sourdough answer 4 again TOPIC:sourdough' }),
    });
    await pivots({ threadId, from: 5, count: 2, runFoldJob: true });

    await expectSameAsRejudged(threadId);
  });

  it('holds when the target is not the newest arrival', async () => {
    const threadId = await newThread('late judgment');
    await onTopic({ threadId, from: 0, count: 3, runFoldJob: true });
    // The judgment ran late: its reply and the next arrival landed first.
    const late = await arrive({ threadId, text: 'sourdough question 3 TOPIC:sourdough' });
    const lateReply = await reply({ threadId, text: 'sourdough answer 3 TOPIC:sourdough' });
    const next = await arrive({ threadId, text: 'question 4 about subject 4' });
    await judge({ threadId, arrivalId: late });
    await foldJob({ threadId, replyId: lateReply });
    await judge({ threadId, arrivalId: next });
    await foldJob({ threadId, replyId: await reply({ threadId, text: 'answer 4' }) });

    await expectSameAsRejudged(threadId);
  });

  it('holds on a Thread whose first arrival is the target', async () => {
    const threadId = await newThread('first arrival');
    const first = await arrive({ threadId, text: 'question 0 about subject 0' });
    await judge({ threadId, arrivalId: first });
    await foldJob({ threadId, replyId: await reply({ threadId, text: 'answer 0' }) });

    const live = await expectSameAsRejudged(threadId);
    expect(live.verdicts.map((row) => row.verdict)).toEqual(['muted']);
    expect(live.folds.map((row) => row.completedTurns)).toEqual([1]);
  });
});
