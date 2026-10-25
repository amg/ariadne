import type { Message } from '@db/types';
import { findSegmentDriftLogByMessageId } from '@queries/segmentDriftLogs/findSegmentDriftLogByMessageId';
import { EMBEDDING_MODEL_ID } from './config';

/**
 * The Thread's paused arrival, which owes the user's choice before anything
 * else enters the Thread: the newest live row is a user Message the gate
 * fired on, with no reply grown beneath it. Null when there is none.
 */
export async function pausedArrivalOrNull(rows: Message[]) {
  const newestLive = rows.filter((row) => !row.abandoned).at(-1);
  if (!newestLive || newestLive.role !== 'user') return null;
  const logged = await findSegmentDriftLogByMessageId({
    messageId: newestLive.id,
    modelId: EMBEDDING_MODEL_ID,
  });
  return logged?.verdict === 'fire' ? newestLive : null;
}
