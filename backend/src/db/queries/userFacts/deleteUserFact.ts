import { db } from '@db/db';

type DeleteUserFactProps = {
  factId: string;
  userId: string;
};

/** Hard-deletes a Fact row. */
export async function deleteUserFact({ factId, userId }: DeleteUserFactProps): Promise<void> {
  await db.deleteFrom('userFacts').where('id', '=', factId).where('userId', '=', userId).execute();
}
