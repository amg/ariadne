import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import {
  type MovedArrival,
  moveArrivalToFreshThreadOrNull,
} from '@queries/threads/moveArrivalToFreshThread';
import { pausedArrivalOrNull } from '@services/aiService';
import { captureClosedSegments, currentSeed } from '@services/memory';
import { type Result, err, ok } from '../types/result';

/**
 * How long a handover waits for the closed segment's capture. Past it the
 * fresh Thread opens without that segment; the capture runs on, or stays
 * owed, for later Threads.
 */
const CAPTURE_WAIT_MS = 20_000;

/** Waits for the work, or for the time limit, whichever comes first. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

type HandOverArrivalProps = {
  userId: string;
  threadId: string;
  messageId: string;
};

/**
 * Moves a paused arrival out of its Thread into a fresh one. The Facts of
 * the segment it closed are captured before the move so the fresh Thread's
 * Seed already knows them, but that capture gets a time limit: when it
 * stalls, the move goes ahead and a background pass keeps retrying the
 * capture afterwards, so the Facts land as soon as the model answers even
 * though the Seed sailed without them. The move itself is one transaction: the arrival is
 * abandoned in place, and the fresh Thread opens with its Seed and the
 * arrival as its stored first message, still awaiting its reply. Either
 * all of that happens or none of it, and only one handover can win.
 */
export async function handOverArrival({
  userId,
  threadId,
  messageId,
}: HandOverArrivalProps): Promise<Result<MovedArrival>> {
  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) return err('thread_not_found');

  const paused = await pausedArrivalOrNull(await listMessagesByThread({ threadId }));
  if (paused?.id !== messageId) {
    return err('arrival_not_paused', 'Only the paused last message can start a new chat.');
  }

  // The handover tries to wait the closed segment's capture out; when it
  // stalls past the limit, the move still goes and a background pass
  // keeps retrying the capture — the segment stays owed until it settles.
  await settledWithin(captureClosedSegments({ userId, threadId }), CAPTURE_WAIT_MS);
  const moved = await moveArrivalToFreshThreadOrNull({
    userId,
    fromThreadId: threadId,
    messageId,
    seed: await currentSeed({ userId }),
  });
  if (!moved) {
    return err('arrival_not_paused', 'The message was already answered or moved.');
  }
  void captureClosedSegments({ userId, threadId });
  return ok(moved);
}
