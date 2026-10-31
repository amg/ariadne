import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  DRIFT_GATE_JUDGE_ARRIVAL,
  enqueueDriftGateJudgeArrival,
  findDriftGateJudgeArrivalJobOrNull,
} from '@queue/tasks/driftGateJudgeArrivalTask';
import { submitChat } from '@services/aiService';
import { editMessage } from '@services/messageService';
import { useRecordedJobCommits } from '@test/jobCommits';
import { memoryOn } from '@test/memory';
import { useTestQueue } from '@test/queue';
import { useTestDb } from '@test/test-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockInferenceServer, startMockInferenceServer } from '../../mock/inferenceServer';

/**
 * What a user typed is stored together with its judgment, and the two stay
 * as durable as any other write: losing the judgment must never lose the
 * Message.
 */

let mock: MockInferenceServer;

beforeAll(async () => {
  mock = await startMockInferenceServer();
  process.env.MOCK_AI_BASE_URL = mock.baseUrl;
});

afterAll(async () => {
  await mock.stop();
});

useTestDb();
useTestQueue({ memory: memoryOn, threadAnalysisMode: 'heuristic' });
const commitSettingsOf = useRecordedJobCommits();

const judging = { enqueueDriftGateJudgeArrival, findDriftGateJudgeArrivalJobOrNull };

async function freshThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId, title: 'Arrival commit' });
  return { userId, threadId };
}

describe('queueing an arrival\u2019s judgment', () => {
  it('commits it, with the arrival, as durably as any write', async () => {
    const { userId, threadId } = await freshThread();

    await submitChat({
      userId,
      threadId,
      content: 'Hello there',
      judging,
      titling: { enqueueThreadGenerateTitle: async () => {} },
      memory: memoryOn,
      threadAnalysisMode: 'heuristic',
    });

    expect(
      (await commitSettingsOf({ operation: 'INSERT', task: DRIFT_GATE_JUDGE_ARRIVAL }))[0],
    ).toBe('on');
  });

  it('commits an edit\u2019s fork, with its judgment, as durably as any write', async () => {
    const { userId, threadId } = await freshThread();
    await insertMessage({ threadId, role: 'user', content: 'Before the edit' });
    await insertMessage({ threadId, role: 'assistant', content: 'Noted.' });
    const last = await insertMessage({ threadId, role: 'user', content: 'The last word' });

    const edited = await editMessage({
      userId,
      threadId,
      messageId: last.id,
      content: 'The last word, reworded',
      judging,
    });

    expect(edited.type).toBe('success');
    expect(
      (await commitSettingsOf({ operation: 'INSERT', task: DRIFT_GATE_JUDGE_ARRIVAL }))[0],
    ).toBe('on');
  });
});
