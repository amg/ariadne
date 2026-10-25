import { db } from '@db/db';

type FindCurrentUserFactProps = {
  factId: string;
  userId: string;
};

/** The user's Fact with this id while it is current; null when missing or superseded. */
export async function findCurrentUserFact({ factId, userId }: FindCurrentUserFactProps) {
  const fact = await db
    .selectFrom('memory.userFacts')
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
