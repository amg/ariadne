import type { DbExecutor } from '@db/types';

/**
 * Opens a Thread's running Exchange: an empty assistant row marked
 * `pending` until settlement flips it. A Thread holds at most one pending
 * reply, so null, with nothing written, when another is already pending.
 * Of two inserts racing, the second waits for the first to commit or roll
 * back before it is decided.
 */
export async function insertPendingReplyOrNull(
  { threadId }: { threadId: string },
  executor: DbExecutor,
) {
  const row = await executor
    .insertInto('chat.messages')
    .values({ threadId, role: 'assistant', content: '', exchangeStatus: 'pending' })
    .onConflict((conflict) =>
      conflict.column('threadId').where('exchangeStatus', '=', 'pending').doNothing(),
    )
    .returningAll()
    .executeTakeFirst();
  return row ?? null;
}
