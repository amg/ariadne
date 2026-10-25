import { db } from '@db/db';
import type { NewMessageUsage } from '@db/types';

export async function insertMessageUsage(usage: NewMessageUsage) {
  return db
    .insertInto('billing.messageUsage')
    .values(usage)
    .returningAll()
    .executeTakeFirstOrThrow();
}
