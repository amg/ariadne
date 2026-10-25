import { db } from '@db/db';

type ListAllUserFactsProps = {
  userId: string;
};

/**
 * All of the user's current Facts (including suppressed), newest first by
 * stated date, or by when they were noted when no date was stated.
 */
export async function listAllUserFacts({ userId }: ListAllUserFactsProps) {
  return db
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
    .where('userId', '=', userId)
    .where('invalidAt', 'is', null)
    .orderBy((eb) => eb.fn.coalesce('validAt', 'createdAt'), 'desc')
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'asc')
    .execute();
}
