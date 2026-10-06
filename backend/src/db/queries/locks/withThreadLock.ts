import { db } from '@db/db';

/**
 * What a Thread lock guards. Each kind serializes on its own, so a capture
 * never waits behind a gate pass on the same Thread.
 */
export type ThreadLockKind = 'live-chain' | 'memory-capture';

/**
 * Runs the work while holding the Thread's lock of the given kind, across
 * every process sharing the database. Later callers wait their turn. The
 * lock is released when the work settles, failed or not, and with the
 * connection if the process dies. Not re-entrant: work holding a lock must
 * not ask for the same one again.
 */
export async function withThreadLock<T>(
  lock: { threadId: string; kind: ThreadLockKind },
  work: () => Promise<T>,
): Promise<T> {
  const name = `${lock.kind}:${lock.threadId}`;
  return db.connection().execute(async (connection) => {
    await connection
      .selectNoFrom((eb) =>
        eb
          .fn('pg_advisory_lock', [eb.fn('hashtextextended', [eb.val(name), eb.lit(0)])])
          .as('locked'),
      )
      .execute();
    try {
      return await work();
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
}
