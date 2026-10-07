import { db } from '@db/db';
import type { Message, SeedLine, Thread } from '@db/types';
import { seedLinesJson } from '@queries/threadSeeds/insertThreadSeed';

type MoveArrivalToFreshThreadProps = {
  userId: string;
  fromThreadId: string;
  messageId: string;
  /** The fresh Thread's Seed, recorded even when empty. */
  seed: { lines: SeedLine[]; factCount: number };
};

export interface MovedArrival {
  thread: Thread;
  /** The arrival's copy, the fresh Thread's first message. */
  message: Message;
}

/**
 * Moves an arrival into a fresh Thread in one transaction: the arrival is
 * abandoned in its old Thread, and the fresh Thread opens with its Seed and
 * a copy of the arrival as its first message. Null, with nothing written,
 * when the arrival is no longer the newest live user Message of its
 * Thread: another handover or a reply got there first.
 */
export async function moveArrivalToFreshThreadOrNull({
  userId,
  fromThreadId,
  messageId,
  seed,
}: MoveArrivalToFreshThreadProps): Promise<MovedArrival | null> {
  return db.transaction().execute(async (trx) => {
    // The conditional update is the claim: the row lock makes a concurrent
    // second claim re-check `abandoned` and miss.
    const claimed = await trx
      .updateTable('chat.messages')
      .set({ abandoned: true })
      .where('id', '=', messageId)
      .where('threadId', '=', fromThreadId)
      .where('role', '=', 'user')
      .where('abandoned', '=', false)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('chat.messages as later')
              .select('later.id')
              .whereRef('later.threadId', '=', 'chat.messages.threadId')
              .whereRef('later.createdAt', '>', 'chat.messages.createdAt')
              .where('later.abandoned', '=', false),
          ),
        ),
      )
      .returning('content')
      .executeTakeFirst();
    if (!claimed) return null;

    const thread = await trx
      .insertInto('chat.threads')
      .values({ userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('memory.threadSeeds')
      .values({
        threadId: thread.id,
        lines: seedLinesJson(seed.lines),
        factCount: seed.factCount,
        handoverMessageId: messageId,
      })
      .execute();
    const message = await trx
      .insertInto('chat.messages')
      .values({ threadId: thread.id, role: 'user', content: claimed.content })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { thread, message };
  });
}
