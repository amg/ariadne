import { db } from '@db/db';

/** The user's stored settings document as written; null when none is stored. */
export async function findUserSettingsDocumentOrNull({
  userId,
}: { userId: string }): Promise<unknown | null> {
  const row = await db
    .selectFrom('memory.userSettings')
    .select('settings')
    .where('userId', '=', userId)
    .executeTakeFirst();
  return row?.settings ?? null;
}
