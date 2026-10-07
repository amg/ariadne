import { db } from '@db/db';
import type { MessageUsage } from '@db/types';

/** The chat exchange's one usage row for a message, when present. */
export async function getMessageUsageByMessageId({
  messageId,
}: {
  messageId: string;
}): Promise<MessageUsage | undefined> {
  return db
    .selectFrom('billing.messageUsage')
    .selectAll()
    .where('messageId', '=', messageId)
    .executeTakeFirst();
}
