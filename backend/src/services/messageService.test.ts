import { randomUUID } from 'node:crypto';
import { getMessageUsageByMessageId } from '@queries/messageUsage/getMessageUsageByMessageId';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { getMessages, updateMessage } from '@services/messageService';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

async function createRandomThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const thread = await insertThread({ user_id: userId, title: 'Test thread' });
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
        thread_id: threadId,
        role: 'user',
        content: 'hello',
      });
      const assistantMessage = await insertMessage({
        thread_id: threadId,
        role: 'assistant',
        content: 'world',
      });
      await insertMessageUsage({
        message_id: assistantMessage.id,
        model: 'Qwen/Qwen3.5-9B',
        provider_id: 'chatcmpl-1',
        prompt_tokens: 5,
        completion_tokens: 1,
        cached_input_tokens: 3,
        cache_write_tokens: 2,
        reasoning_tokens: 1,
        cost_usd: '0.0000006500',
        finish_reason: 'stop',
        latency_ms: 42,
      });

      const messages = await getMessages({ userId, threadId });

      expect(messages?.map((m) => m.content)).toEqual(['hello', 'world']);
      expect(messages?.[0]?.usage).toBeNull();
      expect(messages?.[1]?.usage).toEqual({
        model: 'Qwen/Qwen3.5-9B',
        provider_id: 'chatcmpl-1',
        prompt_tokens: 5,
        completion_tokens: 1,
        cached_input_tokens: 3,
        cache_write_tokens: 2,
        reasoning_tokens: 1,
        cost_usd: '0.0000006500',
        finish_reason: 'stop',
        latency_ms: 42,
      });
    });
  });

  describe('updateMessage', () => {
    it('edits the last user message and drops the reply generated from the old prompt', async () => {
      const { userId, threadId } = await createRandomThread();
      const user = await insertMessage({ thread_id: threadId, role: 'user', content: 'first' });
      const assistant = await insertMessage({
        thread_id: threadId,
        role: 'assistant',
        content: 'stale reply',
      });
      await insertMessageUsage({
        message_id: assistant.id,
        model: 'Qwen/Qwen3.5-9B',
        provider_id: 'chatcmpl-1',
        prompt_tokens: 5,
        completion_tokens: 1,
        cached_input_tokens: null,
        cache_write_tokens: null,
        reasoning_tokens: null,
        cost_usd: '0.0000006500',
        finish_reason: 'stop',
        latency_ms: 42,
      });

      const result = await updateMessage({
        userId,
        threadId,
        messageId: user.id,
        content: '  rewritten prompt  ',
      });

      expect(result).toMatchObject({
        type: 'success',
        data: { id: user.id, role: 'user', content: 'rewritten prompt' },
      });

      // The stale reply is gone (usage cascaded); thread ends at the prompt,
      // ready for the client to immediately retry the exchange.
      const rows = await listMessagesByThread({ threadId });
      expect(rows.map((row) => [row.role, row.content])).toEqual([['user', 'rewritten prompt']]);
      expect(await getMessageUsageByMessageId({ messageId: assistant.id })).toBeUndefined();
    });

    it('rejects empty edits so a bubble can never be blanked out', async () => {
      const { userId, threadId } = await createRandomThread();
      const message = await insertMessage({ thread_id: threadId, role: 'user', content: 'hi' });

      const empty = await updateMessage({ userId, threadId, messageId: message.id, content: '' });
      const blank = await updateMessage({
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
      const message = await insertMessage({ thread_id: threadId, role: 'user', content: 'hi' });

      const result = await updateMessage({
        userId,
        threadId,
        messageId: message.id,
        content: 'x'.repeat(10_001),
      });

      expect(result.type).toBe('error');
      if (result.type === 'error') expect(result.code).toBe('invalid_content');
    });

    it('refuses to edit assistant replies or earlier prompts', async () => {
      const { userId, threadId } = await createRandomThread();
      const earlier = await insertMessage({
        thread_id: threadId,
        role: 'user',
        content: 'early prompt',
      });
      await insertMessage({ thread_id: threadId, role: 'assistant', content: 'answer one' });
      await insertMessage({ thread_id: threadId, role: 'user', content: 'latest prompt' });
      const reply = await insertMessage({
        thread_id: threadId,
        role: 'assistant',
        content: 'answer two',
      });

      const editEarlierUser = await updateMessage({
        userId,
        threadId,
        messageId: earlier.id,
        content: 'rewritten',
      });
      const editAssistant = await updateMessage({
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
      const message = await insertMessage({ thread_id: threadId, role: 'user', content: 'hi' });
      const foreign = await createRandomThread();
      const foreignMessage = await insertMessage({
        thread_id: foreign.threadId,
        role: 'user',
        content: 'theirs',
      });

      // Unknown thread id.
      const unknownThread = await updateMessage({
        userId,
        threadId: randomUUID(),
        messageId: message.id,
        content: 'x',
      });
      // Foreign thread id.
      const foreignThread = await updateMessage({
        userId,
        threadId: foreign.threadId,
        messageId: foreignMessage.id,
        content: 'x',
      });
      // Unknown message id in a valid thread.
      const unknownMessage = await updateMessage({
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
