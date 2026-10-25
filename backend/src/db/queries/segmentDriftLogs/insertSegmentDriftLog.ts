import { db } from '@db/db';
import type { NewSegmentDriftLog } from '@db/types';

/**
 * Logs one judged arrival into the live chain: the composite reading
 * judged, the segment baseline's µ/σ/z snapshot before the arrival joined
 * it, and the verdict. Muted strides keep a row with null numbers.
 * The row's identity is the arrival read BY ITS MODEL — one chain per
 * embedding model runs in parallel, and a duplicate can never land on
 * either: a racing writer owns the survivor and the collision collapses
 * onto it.
 */
export async function insertSegmentDriftLog(row: NewSegmentDriftLog) {
  const inserted = await db
    .insertInto('analysis.segmentDriftLogs')
    .values({
      segmentId: row.segmentId,
      messageId: row.messageId,
      modelId: row.modelId,
      driftP: row.driftP ?? null,
      mu: row.mu ?? null,
      sigma: row.sigma ?? null,
      zScore: row.zScore ?? null,
      verdict: row.verdict,
      fireChannel: row.fireChannel ?? null,
      slowDriftStartMessageId: row.slowDriftStartMessageId ?? null,
    })
    .onConflict((oc) => oc.columns(['messageId', 'modelId']).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (inserted) return inserted;
  const stored = await db
    .selectFrom('analysis.segmentDriftLogs')
    .selectAll()
    .where('messageId', '=', row.messageId)
    .where('modelId', '=', row.modelId)
    .executeTakeFirstOrThrow();
  return stored;
}
