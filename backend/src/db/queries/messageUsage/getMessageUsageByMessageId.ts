import { db } from '@db/db';
import type { MessageUsage } from '@db/types';

type GetMessageUsageByMessageIdProps = {
  messageId: string;
};

export async function getMessageUsageByMessageId({
  messageId,
}: GetMessageUsageByMessageIdProps): Promise<MessageUsage | undefined> {
  return db
    .selectFrom('messageUsage')
    .selectAll()
    .where('messageId', '=', messageId)
    .executeTakeFirst();
}
