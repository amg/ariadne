import { db } from '@db/db';

/** The chat exchange's one usage row for a message, when present. */
export async function getMessageUsageByMessageId({
  messageId,
}: {
  messageId: string;
}) {
  return db
    .selectFrom('billing.messageUsage')
    .selectAll()
    .where('messageId', '=', messageId)
    .executeTakeFirst();
}
