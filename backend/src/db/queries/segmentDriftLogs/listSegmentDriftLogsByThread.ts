import { db } from '@db/db';
import type { SegmentDriftLog } from '@db/types';

type ListSegmentDriftLogsByThreadProps = {
  threadId: string;
  /** Which model's chain to read — one chain per embedding model runs. */
  modelId: string;
};

export interface SegmentDriftLogWithStart extends SegmentDriftLog {
  /** The user Message that starts the segment the arrival was judged in. */
  segmentStartMessageId: string;
}

/**
 * Every arrival verdict recorded for a thread's chain under one embedding
 * model, in chronology, carrying the segment's start Message so consumers
 * can group the live chain without a second join.
 */
export async function listSegmentDriftLogsByThread({
  threadId,
  modelId,
}: ListSegmentDriftLogsByThreadProps): Promise<SegmentDriftLogWithStart[]> {
  const rows = await db
    .selectFrom('segmentDriftLogs as log')
    .innerJoin('threadSegments as seg', 'seg.id', 'log.segmentId')
    .innerJoin('messages as msg', 'msg.id', 'log.messageId')
    .where('msg.threadId', '=', threadId)
    .where('log.modelId', '=', modelId)
    .select([
      'log.id',
      'log.segmentId',
      'log.messageId',
      'log.modelId',
      'log.driftP',
      'log.mu',
      'log.sigma',
      'log.zScore',
      'log.verdict',
      'log.fireChannel',
      'log.createdAt',
      'seg.startMessageId as segmentStartMessageId',
    ])
    .orderBy('log.createdAt', 'asc')
    .orderBy('log.id', 'asc')
    .execute();
  return rows as unknown as SegmentDriftLogWithStart[];
}
