import { db } from '@db/db';

type ListSegmentDriftLogsByThreadProps = {
  threadId: string;
  /** Which model's chain to read — one chain per embedding model runs. */
  modelId: string;
};

/**
 * Every arrival verdict recorded for a thread's chain under one embedding
 * model, in chronology, carrying the segment's start Message so consumers
 * can group the live chain without a second join.
 */
export async function listSegmentDriftLogsByThread({
  threadId,
  modelId,
}: ListSegmentDriftLogsByThreadProps) {
  return db
    .selectFrom('analysis.segmentDriftLogs as log')
    .innerJoin('analysis.threadSegments as seg', 'seg.id', 'log.segmentId')
    .innerJoin('chat.messages as msg', 'msg.id', 'log.messageId')
    .where('msg.threadId', '=', threadId)
    .where('log.modelId', '=', modelId)
    .select([
      'log.segmentId',
      'log.messageId',
      'log.modelId',
      'log.driftP',
      'log.mu',
      'log.sigma',
      'log.zScore',
      'log.verdict',
      'log.fireChannel',
      'log.slowDriftStartMessageId',
      'log.immediateThreshold',
      'log.createdAt',
      'seg.startMessageId as segmentStartMessageId',
    ])
    .orderBy('msg.createdAt', 'asc')
    .orderBy('log.createdAt', 'asc')
    .execute();
}
