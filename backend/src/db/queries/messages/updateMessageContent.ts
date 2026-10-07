import { db } from '@db/db';
import type { Message, MessageExchangeStatus, MessagesTable } from '@db/types';
import type { Updateable } from 'kysely';

type UpdateMessageContentProps = {
  messageId: string;
  content: string;
  /** Exchange state recorded together with the new content. */
  exchangeStatus?: MessageExchangeStatus;
};

/**
 * Replaces a message's content. Used to persist streamed assistant text on
 * natural completion and partial text on stop/timeout/error; the exchange
 * state can settle in the same write.
 */
export async function updateMessageContent({
  messageId,
  content,
  exchangeStatus,
}: UpdateMessageContentProps): Promise<Message> {
  const updates: Updateable<MessagesTable> = { content };
  if (exchangeStatus !== undefined) updates.exchangeStatus = exchangeStatus;
  return db
    .updateTable('chat.messages')
    .set(updates)
    .where('id', '=', messageId)
    .returningAll()
    .executeTakeFirstOrThrow();
}
