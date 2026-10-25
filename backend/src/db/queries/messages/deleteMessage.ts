import { db } from '@db/db';

type DeleteMessageProps = {
  messageId: string;
};

/**
 * Deletes a `messages` row and returns its id, or `undefined` when nothing
 * matched. The 1:1 `message_usage` row cascades via the FK, so callers never
 * have to clean up telemetry themselves.
 */
export async function deleteMessage({ messageId }: DeleteMessageProps) {
  const row = await db
    .deleteFrom('chat.messages')
    .where('id', '=', messageId)
    .returning('id')
    .executeTakeFirst();
  return row?.id;
}
