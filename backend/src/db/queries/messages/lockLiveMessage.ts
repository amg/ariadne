import type { DbExecutor } from '@db/types';

/**
 * Locks a live message row until the transaction ends. A transaction
 * already holding it is waited out first, and the row is judged as that
 * one left it. False, with nothing locked, when the message is not in the
 * Thread or is abandoned.
 */
export async function lockLiveMessage(
  { threadId, messageId }: { threadId: string; messageId: string },
  trx: DbExecutor,
) {
  const row = await trx
    .selectFrom('chat.messages')
    .select('id')
    .where('id', '=', messageId)
    .where('threadId', '=', threadId)
    .where('abandoned', '=', false)
    .forUpdate()
    .executeTakeFirst();
  return row !== undefined;
}
