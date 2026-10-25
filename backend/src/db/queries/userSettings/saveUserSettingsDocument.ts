import { db } from '@db/db';
import { sql } from 'kysely';

/** Replaces the user's whole settings document. */
export async function saveUserSettingsDocument({
  userId,
  settings,
}: {
  userId: string;
  settings: Record<string, unknown>;
}) {
  const document = sql`${JSON.stringify(settings)}::jsonb`;
  await db
    .insertInto('memory.userSettings')
    .values({ userId, settings: document })
    .onConflict((oc) =>
      oc.column('userId').doUpdateSet({ settings: document, updatedAt: sql`now()` }),
    )
    .execute();
}
