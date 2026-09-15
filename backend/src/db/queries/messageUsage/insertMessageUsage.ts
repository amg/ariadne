import { db } from '@db/db';
import type { MessageUsage, NewMessageUsage } from '@db/types';

export async function insertMessageUsage(usage: NewMessageUsage): Promise<MessageUsage> {
  return db.insertInto('messageUsage').values(usage).returningAll().executeTakeFirstOrThrow();
}
