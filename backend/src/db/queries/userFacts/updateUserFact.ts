import { db } from '@db/db';
import type { NewUserFact, UserFact } from '@db/types';
import { toVectorText } from '@queries/messageEmbeddings/embeddingMapping';
import { sql } from 'kysely';

type UpdateUserFactProps =
  | {
      factId: string;
      userId: string;
      /** The row that supersedes the Fact. */
      replacement: Omit<NewUserFact, 'userId'>;
    }
  | {
      factId: string;
      userId: string;
      /** Toggle suppression flag. */
      suppressed: boolean;
    };

const USER_FACT_COLUMNS = [
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
] as const;

/**
 * Updates a Fact. A replacement invalidates the current row and inserts
 * the new one in its place (never overwrites); it throws when the Fact is
 * missing or already superseded. Suppression toggles the flag in place.
 */
export async function updateUserFact(props: UpdateUserFactProps): Promise<UserFact> {
  if ('replacement' in props) {
    const { factId, userId, replacement } = props;
    return db.transaction().execute(async (trx) => {
      await trx
        .updateTable('userFacts')
        .set({ invalidAt: sql`now()` })
        .where('id', '=', factId)
        .where('userId', '=', userId)
        .where('invalidAt', 'is', null)
        .returning('id')
        .executeTakeFirstOrThrow();

      return trx
        .insertInto('userFacts')
        .values({
          ...replacement,
          userId,
          embedding: sql`${toVectorText(replacement.embedding)}::vector`,
        })
        .returning(USER_FACT_COLUMNS)
        .executeTakeFirstOrThrow();
    });
  }
  const { factId, userId, suppressed } = props;
  return db
    .updateTable('userFacts')
    .set({ suppressed })
    .where('id', '=', factId)
    .where('userId', '=', userId)
    .returning(USER_FACT_COLUMNS)
    .executeTakeFirstOrThrow();
}
