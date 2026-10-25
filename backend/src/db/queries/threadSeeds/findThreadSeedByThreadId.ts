import { db } from '@db/db';

/** The Thread's Seed, or null when it was created without one. */
export async function findThreadSeedByThreadId({ threadId }: { threadId: string }) {
  const row = await db
    .selectFrom('memory.threadSeeds')
    .selectAll()
    .where('threadId', '=', threadId)
    .executeTakeFirst();
  return row ?? null;
}
