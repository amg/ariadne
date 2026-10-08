import { db } from '@db/db';

/**
 * What a Thread lock guards. Each kind serializes on its own, so a capture
 * never waits behind a gate pass on the same Thread.
 */
export type ThreadLockKind = 'live-chain' | 'memory-capture';

/** How long a waiter sleeps between attempts, holding no connection. */
const RETRY_INTERVAL_MS = 25;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Attempt<T> = { acquired: false } | { acquired: true; value: T };

/**
 * Runs the work while holding the Thread's lock of the given kind, across
 * every process sharing the database. Later callers wait their turn, in no
 * guaranteed order, and hold no database connection while they wait. The
 * lock is released when the work settles, failed or not, and with the
 * connection if the process dies. Not re-entrant: work holding a lock must
 * not ask for the same one again.
 */
export async function withThreadLock<T>(
  lock: { threadId: string; kind: ThreadLockKind },
  work: () => Promise<T>,
): Promise<T> {
  const name = `${lock.kind}:${lock.threadId}`;
  for (;;) {
    const attempt = await db.connection().execute(async (connection): Promise<Attempt<T>> => {
      const { locked } = await connection
        .selectNoFrom((eb) =>
          eb
            .fn<boolean>('pg_try_advisory_lock', [
              eb.fn('hashtextextended', [eb.val(name), eb.lit(0)]),
            ])
            .as('locked'),
        )
        .executeTakeFirstOrThrow();
      if (!locked) return { acquired: false };
      try {
        return { acquired: true, value: await work() };
      } finally {
        await connection
          .selectNoFrom((eb) =>
            eb
              .fn('pg_advisory_unlock', [eb.fn('hashtextextended', [eb.val(name), eb.lit(0)])])
              .as('unlocked'),
          )
          .execute();
      }
    });
    if (attempt.acquired) return attempt.value;
    await sleep(RETRY_INTERVAL_MS);
  }
}
