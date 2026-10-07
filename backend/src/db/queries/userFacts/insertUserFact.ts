import { db } from '@db/db';
import type { NewUserFact, UserFact } from '@db/types';
import { toVectorText } from '@queries/messageEmbeddings/embeddingMapping';
import { sql } from 'kysely';

/** Stores one Fact; the vector is written but never read back. */
export async function insertUserFact(row: NewUserFact): Promise<UserFact> {
  return db
    .insertInto('userFacts')
    .values({ ...row, embedding: sql`${toVectorText(row.embedding)}::vector` })
    .returning([
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
    .executeTakeFirstOrThrow();
}
