import { db } from '@db/db';
import type { Message } from '@db/types';

type UpdateMessageContentProps = {
  messageId: string;
  content: string;
};

/**
 * Replaces a message's content. Used to persist streamed assistant text on
 * natural completion and partial text on stop/timeout/error.
 */
export async function updateMessageContent({
  messageId,
  content,
}: UpdateMessageContentProps): Promise<Message> {
  return db
    .updateTable('messages')
    .set({ content })
    .where('id', '=', messageId)
    .returningAll()
    .executeTakeFirstOrThrow();
}
