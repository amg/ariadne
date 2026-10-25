import { db } from '@db/db';

type DeleteUserFactProps = {
  factId: string;
  userId: string;
};

/** Hard-deletes a Fact row. False when the user has no Fact with that id. */
export async function deleteUserFact({ factId, userId }: DeleteUserFactProps) {
  const deleted = await db
    .deleteFrom('memory.userFacts')
    .where('id', '=', factId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  return deleted.numDeletedRows > 0n;
}
