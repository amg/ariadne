import { db } from '@db/db';
import type { MessageSideCost, SideCostKind } from '@db/types';

/** One expansion step's spend row for a message, when present. */
export async function getSideCostByMessageId({
  messageId,
  kind,
}: {
  messageId: string;
  kind: SideCostKind;
}): Promise<MessageSideCost | undefined> {
  return db
    .selectFrom('messageSideCosts')
    .selectAll()
    .where('messageId', '=', messageId)
    .where('kind', '=', kind)
    .executeTakeFirst();
}
