import { db } from '@db/db';

/** Whether the message left its Thread through a handover. */
export async function isHandedOverMessage({ messageId }: { messageId: string }): Promise<boolean> {
  const row = await db
    .selectFrom('threadSeeds')
    .select('threadId')
    .where('handoverMessageId', '=', messageId)
    .executeTakeFirst();
  return row !== undefined;
}
