import { db } from '@db/db';
import type { Message, MessageExchangeStatus } from '@db/types';

type UpdateExchangeStatusProps = {
  messageId: string;
  exchangeStatus: MessageExchangeStatus;
};

/** Settles a message's exchange state without touching its content. */
export async function updateExchangeStatus({
  messageId,
  exchangeStatus,
}: UpdateExchangeStatusProps): Promise<Message> {
  return db
    .updateTable('chat.messages')
    .set({ exchangeStatus })
    .where('id', '=', messageId)
    .returningAll()
    .executeTakeFirstOrThrow();
}
