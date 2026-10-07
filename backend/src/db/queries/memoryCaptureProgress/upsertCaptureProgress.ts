import { db } from '@db/db';
import { sql } from 'kysely';

type UpsertProps = {
  segmentId: string;
  /** `created_at` of the latest Turn the capture took in. */
  throughAt: Date;
};

/**
 * Records how far a segment's Fact capture has gone. Guarded so two passes
 * racing on the same anchor only ever move the pointer forward.
 */
export async function upsertCaptureProgress({ segmentId, throughAt }: UpsertProps): Promise<void> {
  await db
    .insertInto('memory.memoryCaptureProgress')
    .values({ segmentId, capturedThroughAt: throughAt })
    .onConflict((oc) =>
      oc.column('segmentId').doUpdateSet({
        capturedThroughAt: sql`greatest(memory.memory_capture_progress.captured_through_at, ${throughAt})`,
        updatedAt: sql`now()`,
      }),
    )
    .execute();
}

/** Reads a segment's capture pointer, if capture has reached it once. */
export async function captureProgressOf(segmentId: string): Promise<Date | null> {
  const row = await db
    .selectFrom('memory.memoryCaptureProgress')
    .select('capturedThroughAt')
    .where('segmentId', '=', segmentId)
    .executeTakeFirst();
  return row?.capturedThroughAt ?? null;
}
