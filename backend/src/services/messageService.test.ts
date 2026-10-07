import { randomUUID } from 'node:crypto';
import { getMessageUsageByMessageId } from '@queries/messageUsage/getMessageUsageByMessageId';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { setMessagesAbandoned } from '@queries/messages/setMessagesAbandoned';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import {
  DRIFT_GATE_JUDGE_ARRIVAL,
  enqueueDriftGateJudgeArrival,
} from '@queue/tasks/driftGateJudgeArrivalTask';
import { SYSTEM_PROMPT } from '@services/aiService/config';
import { editMessage, getMessages } from '@services/messageService';
import { addDeadJob } from '@test/queue';
import { useTestDb } from '@test/test-db';

const judging = { enqueueDriftGateJudgeArrival };
import { describe, expect, it } from 'vitest';

async function createRandomThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ userId: userId, title: 'Test thread' });
  return { userId, threadId: thread.id };
}

describe('messageService', () => {
  useTestDb();

  describe('getMessages', () => {
    it('returns null when the thread is unknown or foreign', async () => {
      const { userId } = await createRandomThread();

      expect(await getMessages({ userId, threadId: randomUUID() })).toBeNull();

      const other = await createRandomThread();
      expect(await getMessages({ userId, threadId: other.threadId })).toBeNull();
    });

    it('returns messages with usage nested when a usage row exists', async () => {
      const { userId, threadId } = await createRandomThread();
      const userMessage = await insertMessage({
        threadId: threadId,
        role: 'user',
        content: 'hello',
      });
      const assistantMessage = await insertMessage({
        threadId: threadId,
        role: 'assistant',
        content: 'world',
      });
      await insertMessageUsage({
        messageId: assistantMessage.id,
        model: 'Qwen/Qwen3.5-9B',
        providerId: 'chatcmpl-1',
        promptTokens: 5,
        completionTokens: 1,
        cachedInputTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 1,
        costUsd: '0.0000006500',
        finishReason: 'stop',
        latencyMs: 42,
      });

      const messages = await getMessages({ userId, threadId });

      expect(messages?.map((m) => m.content)).toEqual([SYSTEM_PROMPT, 'hello', 'world']);
      expect(messages?.[0]?.usage).toBeNull();
      expect(messages?.[1]?.usage).toBeNull();
      expect(messages?.[2]?.usage).toEqual({
        model: 'Qwen/Qwen3.5-9B',
        providerId: 'chatcmpl-1',
        promptTokens: 5,
        completionTokens: 1,
        cachedInputTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 1,
        estimatedReasoningTokens: null,
        costUsd: '0.0000006500',
        finishReason: 'stop',
        latencyMs: 42,
        estimated: false,
      });
    });

    it('flags the unanswered arrival whose judgment gave up for good, and no other row', async () => {
      const { userId, threadId } = await createRandomThread();
      await insertMessage({ threadId, role: 'user', content: 'answered' });
      await insertMessage({ threadId, role: 'assistant', content: 'reply' });
      const arrival = await insertMessage({ threadId, role: 'user', content: 'died on the gate' });
      await addDeadJob({
        task: DRIFT_GATE_JUDGE_ARRIVAL,
        key: arrival.id,
        payload: { userId, threadId, messageId: arrival.id },
        errorClass: 'fatal',
      });

      const messages = await getMessages({ userId, threadId });

      expect(messages?.map((m) => m.gateFailed)).toEqual([false, false, false, true]);
    });

    it('leaves an arrival unflagged while its judgment can still be retried', async () => {
      const { userId, threadId } = await createRandomThread();
      const arrival = await insertMessage({ threadId, role: 'user', content: 'gave up for now' });
      await addDeadJob({
        task: DRIFT_GATE_JUDGE_ARRIVAL,
        key: arrival.id,
        payload: { userId, threadId, messageId: arrival.id },
        errorClass: 'recoverable',
      });

      const messages = await getMessages({ userId, threadId });

      expect(messages?.some((m) => m.gateFailed)).toBe(false);
    });
  });

  describe('editMessage', () => {
    it('forks the edit: abandons the old arrival and inserts the edited text as a new one', async () => {
      const { userId, threadId } = await createRandomThread();
      const user = await insertMessage({ threadId: threadId, role: 'user', content: 'first' });
      const assistant = await insertMessage({
        threadId: threadId,
        role: 'assistant',
        content: 'stale reply',
      });
      await insertMessageUsage({
        messageId: assistant.id,
        model: 'Qwen/Qwen3.5-9B',
        providerId: 'chatcmpl-1',
        promptTokens: 5,
        completionTokens: 1,
        cachedInputTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: '0.0000006500',
        finishReason: 'stop',
        latencyMs: 42,
      });

      const result = await editMessage({
        judging,
        userId,
        threadId,
        messageId: user.id,
        content: '  rewritten prompt  ',
      });

      // The response carries the forked row, not the old one.
      expect(result).toMatchObject({
        type: 'success',
        data: { role: 'user', content: 'rewritten prompt' },
      });
      if (result.type !== 'success') throw new Error('expected success');
      expect(result.data.id).not.toBe(user.id);

      // The old turn stays — original text intact, flagged abandoned along
      // with the reply it generated (its usage keeps tracking the pre-edit
      // cost); the stale reply keeps its spend row; the forked row ends the
      // thread.
      const rows = await listMessagesByThread({ threadId });
      expect(rows.map((row) => [row.role, row.content, row.abandoned])).toEqual([
        ['user', 'first', true],
        ['assistant', 'stale reply', true],
        ['user', 'rewritten prompt', false],
      ]);
      expect(await getMessageUsageByMessageId({ messageId: assistant.id })).toBeDefined();
    });

    it('rejects empty edits so a bubble can never be blanked out', async () => {
      const { userId, threadId } = await createRandomThread();
      const message = await insertMessage({ threadId: threadId, role: 'user', content: 'hi' });

      const empty = await editMessage({
        judging,
        userId,
        threadId,
        messageId: message.id,
        content: '',
      });
      const blank = await editMessage({
        judging,
        userId,
        threadId,
        messageId: message.id,
        content: '   ',
      });

      expect(empty).toEqual({
        type: 'error',
        code: 'invalid_content',
        message: expect.any(String),
      });
      expect(blank).toEqual({
        type: 'error',
        code: 'invalid_content',
        message: expect.any(String),
      });

      const rows = await listMessagesByThread({ threadId });
      expect(rows[0]?.content).toBe('hi');
    });

    it('rejects overlong content', async () => {
      const { userId, threadId } = await createRandomThread();
      const message = await insertMessage({ threadId: threadId, role: 'user', content: 'hi' });

      const result = await editMessage({
        judging,
        userId,
        threadId,
        messageId: message.id,
        content: 'x'.repeat(10_001),
      });

      expect(result.type).toBe('error');
      if (result.type === 'error') expect(result.code).toBe('invalid_content');
    });

    it('edits the last visible prompt when a handed-over arrival trails it', async () => {
      const { userId, threadId } = await createRandomThread();
      await insertMessage({ threadId, role: 'user', content: 'I love rabbits' });
      await insertMessage({ threadId, role: 'assistant', content: 'Lovely.' });
      const lastVisible = await insertMessage({
        threadId,
        role: 'user',
        content: 'Had them for years',
      });
      await insertMessage({ threadId, role: 'assistant', content: 'Wonderful.' });
      const handedOver = await insertMessage({
        threadId,
        role: 'user',
        content: 'Best hot spring?',
      });
      await setMessagesAbandoned({ messageIds: [handedOver.id], abandoned: true });

      const result = await editMessage({
        judging,
        userId,
        threadId,
        messageId: lastVisible.id,
        content: 'Had them for years.',
      });

      expect(result).toMatchObject({ type: 'success', data: { content: 'Had them for years.' } });
    });

    it('refuses to edit assistant replies or earlier prompts', async () => {
      const { userId, threadId } = await createRandomThread();
      const earlier = await insertMessage({
        threadId: threadId,
        role: 'user',
        content: 'early prompt',
      });
      await insertMessage({ threadId: threadId, role: 'assistant', content: 'answer one' });
      await insertMessage({ threadId: threadId, role: 'user', content: 'latest prompt' });
      const reply = await insertMessage({
        threadId: threadId,
        role: 'assistant',
        content: 'answer two',
      });

      const editEarlierUser = await editMessage({
        judging,
        userId,
        threadId,
        messageId: earlier.id,
        content: 'rewritten',
      });
      const editAssistant = await editMessage({
        judging,
        userId,
        threadId,
        messageId: reply.id,
        content: 'rewritten',
      });

      expect(editEarlierUser).toEqual({
        type: 'error',
        code: 'not_last',
        message: expect.any(String),
      });
      expect(editAssistant).toEqual({
        type: 'error',
        code: 'not_last',
        message: expect.any(String),
      });
    });

    it('returns thread_not_found for unknown/foreign threads, foreign or missing messages', async () => {
      const { userId, threadId } = await createRandomThread();
      const message = await insertMessage({ threadId: threadId, role: 'user', content: 'hi' });
      const foreign = await createRandomThread();
      const foreignMessage = await insertMessage({
        threadId: foreign.threadId,
        role: 'user',
        content: 'theirs',
      });

      // Unknown thread id.
      const unknownThread = await editMessage({
        judging,
        userId,
        threadId: randomUUID(),
        messageId: message.id,
        content: 'x',
      });
      // Foreign thread id.
      const foreignThread = await editMessage({
        judging,
        userId,
        threadId: foreign.threadId,
        messageId: foreignMessage.id,
        content: 'x',
      });
      // Unknown message id in a valid thread.
      const unknownMessage = await editMessage({
        judging,
        userId,
        threadId,
        messageId: randomUUID(),
        content: 'x',
      });

      expect(unknownThread).toEqual({ type: 'error', code: 'thread_not_found' });
      expect(foreignThread).toEqual({ type: 'error', code: 'thread_not_found' });
      expect(unknownMessage).toEqual({ type: 'error', code: 'thread_not_found' });
    });
  });
});
