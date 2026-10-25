import { randomUUID } from 'node:crypto';
import { deleteMessage } from '@queries/messages/deleteMessage';
import { insertMessage } from '@queries/messages/insertMessage';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';
import { ChatExchange } from './exchange';

useTestDb();

/** A pending assistant reply row an exchange can settle into. */
async function pendingReply() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId });
  const { id: messageId } = await insertMessage({
    threadId,
    role: 'assistant',
    content: '',
    exchangeStatus: 'pending',
  });
  return { threadId, messageId };
}

function exchangeFor({
  messageId,
  estimatePromptTokens,
  idleTimeoutMs = 0,
}: {
  messageId: string;
  estimatePromptTokens?: () => number;
  idleTimeoutMs?: number;
}) {
  return new ChatExchange({
    assistantMessageId: messageId,
    model: 'qwen/test-model',
    estimatePromptTokens: estimatePromptTokens ?? (() => 42),
    idleTimeoutMs,
    onIdleTimeout: () => {},
  });
}

describe('ChatExchange settlement', () => {
  it('settles an interrupted outcome although the reply row is gone', async () => {
    const { messageId } = await pendingReply();
    const exchange = exchangeFor({ messageId });
    exchange.recordTextDelta('partial answ');
    await deleteMessage({ messageId });

    await exchange.completeAbort();

    expect(await exchange.outcome).toEqual({
      type: 'success',
      data: { finishReason: 'interrupted', usagePersisted: false, latencyMs: 0 },
    });
  });

  it('settles a stream_timeout outcome although the reply row is gone', async () => {
    const { messageId } = await pendingReply();
    const exchange = exchangeFor({ messageId, idleTimeoutMs: 15 });
    exchange.recordTextDelta('t');
    await new Promise((resolve) => setTimeout(resolve, 60));
    await deleteMessage({ messageId });

    await exchange.completeAbort();

    expect(await exchange.outcome).toEqual({
      type: 'error',
      code: 'stream_timeout',
      message: 'The stream went idle between tokens.',
    });
  });

  it('settles the provider error although the reply row is gone', async () => {
    const { messageId } = await pendingReply();
    const exchange = exchangeFor({ messageId });
    exchange.recordTextDelta('partial answ');
    await deleteMessage({ messageId });

    await exchange.completeError(new Error('socket hang up'));

    expect(await exchange.outcome).toEqual({
      type: 'error',
      code: 'provider_error',
      message: 'socket hang up',
    });
  });

  it('settles the reply text and still reports the provider error when the spend estimate fails', async () => {
    const { threadId, messageId } = await pendingReply();
    const exchange = exchangeFor({
      messageId,
      estimatePromptTokens: () => {
        throw new Error('token count failed');
      },
    });
    exchange.recordTextDelta('partial answ');

    await exchange.completeNatural({ finishReason: 'error' });

    expect(await exchange.outcome).toEqual({
      type: 'error',
      code: 'provider_error',
      message: 'The provider aborted the stream.',
    });
    const reply = (await listMessagesByThread({ threadId })).find((row) => row.id === messageId);
    expect(reply?.content).toBe('partial answ');
    expect(reply?.exchangeStatus).toBe('error');
  });
});
