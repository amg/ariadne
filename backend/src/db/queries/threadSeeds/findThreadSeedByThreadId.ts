import { db } from '@db/db';
import type { ThreadSeed } from '@db/types';

/** The Thread's Seed, or null when it was created without one. */
export async function findThreadSeedByThreadIdOrNull({
  threadId,
}: { threadId: string }): Promise<ThreadSeed | null> {
  const row = await db
    .selectFrom('threadSeeds')
    .selectAll()
    .where('threadId', '=', threadId)
    .executeTakeFirst();
  return row ?? null;
}
