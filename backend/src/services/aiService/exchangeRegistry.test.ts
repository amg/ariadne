import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { onStopRequested } from '@services/events';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';
import type { ChatStreamHandle } from '../../types/aiService';
import {
  clearActiveExchange,
  registerActiveExchange,
  stopThreadExchange,
} from './exchangeRegistry';

useTestDb();

function fakeHandle() {
  const counters = { aborts: 0 };
  const handle = {
    abort: () => {
      counters.aborts += 1;
    },
  } as unknown as ChatStreamHandle;
  return {
    handle,
    get aborts() {
      return counters.aborts;
    },
  };
}

function someThread() {
  return { userId: randomUUID(), threadId: randomUUID() };
}

/** A Thread whose reply is pending, created `ageMs` ago, as another copy would leave it. */
async function threadWithPendingReply(ageMs: number) {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId });
  await insertMessage({ threadId, role: 'user', content: 'Tell me about tides' });
  await insertMessage({
    threadId,
    role: 'assistant',
    content: '',
    exchangeStatus: 'pending',
    createdAt: new Date(Date.now() - ageMs),
  });
  return { userId, threadId };
}

describe('exchangeRegistry', () => {
  it('stops the thread’s registered exchange', async () => {
    const target = someThread();
    const fake = fakeHandle();
    registerActiveExchange(target, fake.handle);

    expect(await stopThreadExchange(target)).toBe(true);
    expect(fake.aborts).toBe(1);
    // Stopping again is a no-op: the mapping survives until outcome clears it.
    expect(await stopThreadExchange(target)).toBe(true);
    expect(fake.aborts).toBe(2);
    clearActiveExchange(target.threadId, fake.handle);
  });

  it('knows when nothing is running anywhere', async () => {
    expect(await stopThreadExchange(someThread())).toBe(false);
  });

  it('clears only its own handle', async () => {
    const target = someThread();
    const first = fakeHandle();
    const second = fakeHandle();
    registerActiveExchange(target, first.handle);
    registerActiveExchange(target, second.handle);

    // A late settlement clearing a superseded handle must not drop the mapping.
    clearActiveExchange(target.threadId, first.handle);
    expect(await stopThreadExchange(target)).toBe(true);
    expect(second.aborts).toBe(1);
    expect(first.aborts).toBe(0);

    clearActiveExchange(target.threadId, second.handle);
    expect(await stopThreadExchange(target)).toBe(false);
  });

  it('asks the copy streaming the exchange to stop it', async () => {
    const target = await threadWithPendingReply(1_000);
    let stopsHeard = 0;
    // The copy running the exchange, listening for its stop.
    const elsewhere = onStopRequested(target, () => {
      stopsHeard += 1;
    });
    try {
      expect(await stopThreadExchange(target)).toBe(true);
      expect(stopsHeard).toBe(1);
    } finally {
      elsewhere.close();
    }
  });

  it('asks nothing of a pending reply whose process is long gone', async () => {
    const target = await threadWithPendingReply(24 * 60 * 60 * 1_000);
    let stopsHeard = 0;
    const elsewhere = onStopRequested(target, () => {
      stopsHeard += 1;
    });
    try {
      expect(await stopThreadExchange(target)).toBe(false);
      expect(stopsHeard).toBe(0);
    } finally {
      elsewhere.close();
    }
  });
});
