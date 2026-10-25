import { db } from '@db/db';
import type { NewMessageUsage } from '@db/types';

/**
 * Records a message's usage row unless one is already there. True when
 * this call inserted it, false when an earlier row stands.
 */
export async function insertMessageUsageIfAbsent(usage: NewMessageUsage) {
  const row = await db
    .insertInto('billing.messageUsage')
    .values(usage)
    .onConflict((conflict) => conflict.column('messageId').doNothing())
    .returning('messageId')
    .executeTakeFirst();
  return row !== undefined;
}
