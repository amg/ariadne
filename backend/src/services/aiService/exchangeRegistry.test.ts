import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  clearActiveExchange,
  registerActiveExchange,
  stopThreadExchange,
} from './exchangeRegistry';
import type { ChatStreamHandle } from './submitChat';

function fakeHandle(): { handle: ChatStreamHandle; aborts: number } {
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

describe('exchangeRegistry', () => {
  it('stops the thread’s registered exchange', () => {
    const threadId = randomUUID();
    const fake = fakeHandle();
    registerActiveExchange(threadId, fake.handle);

    expect(stopThreadExchange(threadId)).toBe(true);
    expect(fake.aborts).toBe(1);
    // Stopping again is a no-op: the mapping survives until outcome clears it.
    expect(stopThreadExchange(threadId)).toBe(true);
    expect(fake.aborts).toBe(2);
  });

  it('knows when nothing is running', () => {
    expect(stopThreadExchange(randomUUID())).toBe(false);
  });

  it('clears only its own handle', () => {
    const threadId = randomUUID();
    const first = fakeHandle();
    const second = fakeHandle();
    registerActiveExchange(threadId, first.handle);
    registerActiveExchange(threadId, second.handle);

    // A late settlement clearing a superseded handle must not drop the mapping.
    clearActiveExchange(threadId, first.handle);
    expect(stopThreadExchange(threadId)).toBe(true);
    expect(second.aborts).toBe(1);

    clearActiveExchange(threadId, second.handle);
    expect(stopThreadExchange(threadId)).toBe(false);
  });
});
