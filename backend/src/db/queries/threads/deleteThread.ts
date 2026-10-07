import { db } from '@db/db';

type DeleteThreadProps = {
  userId: string;
  threadId: string;
};

/**
 * Deletes a thread owned by the user. Messages go with it via the FK
 * `ON DELETE CASCADE`. Returns true only when a row actually vanished;
 * unknown ids and foreign threads both yield false (no existence leakage).
 */
export async function deleteThread({ userId, threadId }: DeleteThreadProps): Promise<boolean> {
  const result = await db
    .deleteFrom('chat.threads')
    .where('id', '=', threadId)
    .where('userId', '=', userId)
    .executeTakeFirst();

  return Number(result.numDeletedRows) > 0;
}
