import { db } from '@db/db';
import type { DbExecutor, NewUserFact } from '@db/types';
import { toVectorText } from '@queries/messageEmbeddings/embeddingMapping';
import { sql } from 'kysely';

/** One Fact a capture read, stored in the order it was read. */
interface CapturedFact {
  /** Chosen by the capture, so a later Fact of the same read can replace this one. */
  id: string;
  row: NewUserFact;
  /** The current Fact this one supersedes; null for a new Fact. */
  replacesFactId: string | null;
}

type RecordSegmentCaptureProps = {
  segmentId: string;
  /** The segment's capture pointer as the capture read it; null when it had none. */
  readFrom: Date | null;
  /** Where the pointer moves: `created_at` of the latest Turn the capture took in. */
  throughAt: Date;
  facts: CapturedFact[];
};

/** Rolls the capture back when another pass moved the pointer first. */
class CapturedByAnotherPass extends Error {}

/** Moves the pointer from where the capture read it; false when it is no longer there. */
async function pointerMoved(
  trx: DbExecutor,
  { segmentId, readFrom, throughAt }: RecordSegmentCaptureProps,
) {
  if (readFrom === null) {
    const inserted = await trx
      .insertInto('memory.memoryCaptureProgress')
      .values({ segmentId, capturedThroughAt: throughAt })
      .onConflict((oc) => oc.column('segmentId').doNothing())
      .returning('segmentId')
      .executeTakeFirst();
    return inserted !== undefined;
  }
  const updated = await trx
    .updateTable('memory.memoryCaptureProgress')
    .set({ capturedThroughAt: throughAt, updatedAt: sql`now()` })
    .where('segmentId', '=', segmentId)
    .where('capturedThroughAt', '=', readFrom)
    .returning('segmentId')
    .executeTakeFirst();
  return updated !== undefined;
}

/**
 * Stores one Fact, in place of the one it replaces when it names one. A
 * replaced Fact another pass superseded or deleted meanwhile keeps that
 * pass's reading, and this Fact is dropped.
 */
async function storeFact(trx: DbExecutor, { id, row, replacesFactId }: CapturedFact) {
  if (replacesFactId !== null) {
    const superseded = await trx
      .updateTable('memory.userFacts')
      .set({ invalidAt: sql`now()` })
      .where('id', '=', replacesFactId)
      .where('userId', '=', row.userId)
      .where('invalidAt', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!superseded) return;
  }
  await trx
    .insertInto('memory.userFacts')
    .values({ ...row, id, embedding: sql`${toVectorText(row.embedding)}::vector` })
    .execute();
}

/**
 * Stores a segment capture: its Facts, and the segment's pointer moved
 * past the Turns it read, together or not at all. False, with nothing
 * written, when the pointer no longer holds the value the capture read:
 * another pass captured those Turns first.
 */
export async function recordSegmentCapture(props: RecordSegmentCaptureProps) {
  try {
    await db.transaction().execute(async (trx) => {
      if (!(await pointerMoved(trx, props))) throw new CapturedByAnotherPass();
      for (const fact of props.facts) await storeFact(trx, fact);
    });
    return true;
  } catch (error) {
    if (error instanceof CapturedByAnotherPass) return false;
    throw error;
  }
}
