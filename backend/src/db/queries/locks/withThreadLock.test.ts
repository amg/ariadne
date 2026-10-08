import { randomUUID } from 'node:crypto';
import { db } from '@db/db';
import { withThreadLock } from '@queries/locks/withThreadLock';
import { useTestDb } from '@test/test-db';
import { describe, expect, it } from 'vitest';

useTestDb();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Work that logs when it starts and ends, holding the lock in between. */
function loggedWork(log: string[], label: string, ms = 40) {
  return async () => {
    log.push(`${label}:start`);
    await sleep(ms);
    log.push(`${label}:end`);
    return label;
  };
}

describe('withThreadLock', () => {
  it('runs work on one Thread one at a time', async () => {
    const threadId = randomUUID();
    const log: string[] = [];

    const results = await Promise.all([
      withThreadLock({ threadId, kind: 'live-chain' }, loggedWork(log, 'first')),
      withThreadLock({ threadId, kind: 'live-chain' }, loggedWork(log, 'second')),
    ]);

    expect(results).toEqual(['first', 'second']);
    expect(log).toEqual(
      log[0] === 'first:start'
        ? ['first:start', 'first:end', 'second:start', 'second:end']
        : ['second:start', 'second:end', 'first:start', 'first:end'],
    );
  });

  it('lets other Threads, and other kinds of work on the same Thread, run alongside', async () => {
    const threadId = randomUUID();
    const log: string[] = [];

    await Promise.all([
      withThreadLock({ threadId, kind: 'live-chain' }, loggedWork(log, 'gate')),
      withThreadLock({ threadId, kind: 'memory-capture' }, loggedWork(log, 'capture')),
      withThreadLock({ threadId: randomUUID(), kind: 'live-chain' }, loggedWork(log, 'other')),
    ]);

    expect(log.slice(0, 3).every((entry) => entry.endsWith(':start'))).toBe(true);
  });

  it('completes every waiter in turn when they outnumber the pool connections', async () => {
    const threadId = randomUUID();
    const waiters = 15;

    const results = await Promise.all(
      Array.from({ length: waiters }, (_, index) =>
        withThreadLock({ threadId, kind: 'memory-capture' }, async () => {
          await sleep(5);
          const row = await db
            .selectNoFrom((eb) => eb.val(index).as('index'))
            .executeTakeFirstOrThrow();
          return Number(row.index);
        }),
      ),
    );

    expect(results).toEqual(Array.from({ length: waiters }, (_, index) => index));
  });

  it('releases the lock when the work fails', async () => {
    const threadId = randomUUID();

    await expect(
      withThreadLock({ threadId, kind: 'live-chain' }, async () => {
        throw new Error('pass failed');
      }),
    ).rejects.toThrow('pass failed');

    const next = await Promise.race([
      withThreadLock({ threadId, kind: 'live-chain' }, async () => 'acquired'),
      sleep(2000).then(() => 'still locked'),
    ]);
    expect(next).toBe('acquired');
  });
});
