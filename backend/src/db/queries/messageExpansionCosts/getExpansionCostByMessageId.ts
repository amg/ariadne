import { db } from '@db/db';
import type { ExpansionCostKind, MessageExpansionCost } from '@db/types';

/** One expansion step's spend row for a message, when present. */
export async function getExpansionCostByMessageId({
  messageId,
  kind,
}: {
  messageId: string;
  kind: ExpansionCostKind;
}): Promise<MessageExpansionCost | undefined> {
  return db
    .selectFrom('messageExpansionCosts')
    .selectAll()
    .where('messageId', '=', messageId)
    .where('kind', '=', kind)
    .executeTakeFirst();
}
