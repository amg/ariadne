import { db } from '@db/db';
import { toVectorText } from '@queries/messageEmbeddings/embeddingMapping';
import { sql } from 'kysely';

export interface NearUserFact {
  id: string;
  content: string;
  suppressed: boolean;
  /** Cosine distance to the probe vector, 0 = identical direction. */
  distance: number;
}

type ListNearestUserFactsProps = {
  userId: string;
  embedding: number[];
  /** Only Facts embedded by this model are comparable. */
  modelId: string;
  limit: number;
};

/**
 * The user's current Facts closest to a vector, nearest first. Suppressed
 * Facts are included: they are still known, only kept out of Seeds.
 * Invalidated Facts are not.
 */
export async function listNearestUserFacts({
  userId,
  embedding,
  modelId,
  limit,
}: ListNearestUserFactsProps): Promise<NearUserFact[]> {
  const probe = sql`${toVectorText(embedding)}::vector`;
  const rows = await db
    .selectFrom('memory.userFacts')
    .select(['id', 'content', 'suppressed', sql<number>`embedding <=> ${probe}`.as('distance')])
    .where('userId', '=', userId)
    .where('modelId', '=', modelId)
    .where('invalidAt', 'is', null)
    .orderBy(sql`embedding <=> ${probe}`)
    .limit(limit)
    .execute();
  return rows.map((row) => ({ ...row, distance: Number(row.distance) }));
}
