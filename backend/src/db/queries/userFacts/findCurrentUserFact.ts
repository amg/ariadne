import { db } from '@db/db';
import type { UserFact } from '@db/types';

type FindCurrentUserFactProps = {
  factId: string;
  userId: string;
};

/** The user's Fact with this id while it is current; null when missing or superseded. */
export async function findCurrentUserFactOrNull({
  factId,
  userId,
}: FindCurrentUserFactProps): Promise<UserFact | null> {
  const fact = await db
    .selectFrom('userFacts')
    .select([
      'id',
      'userId',
      'content',
      'category',
      'subject',
      'predicate',
      'object',
      'modelId',
      'sourceMessageId',
      'validAt',
      'invalidAt',
      'suppressed',
      'createdAt',
    ])
    .where('id', '=', factId)
    .where('userId', '=', userId)
    .where('invalidAt', 'is', null)
    .executeTakeFirst();
  return fact ?? null;
}
