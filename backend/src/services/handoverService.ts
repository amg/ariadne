import { env } from '@config/env';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { findSegmentDriftLogByMessageId } from '@queries/segmentDriftLogs/findSegmentDriftLogByMessageId';
import { findThreadByIdAndUser } from '@queries/threads/findThreadByIdAndUser';
import {
  type MovedArrival,
  moveArrivalToFreshThreadOrNull,
} from '@queries/threads/moveArrivalToFreshThread';
import { EMBEDDING_MODEL_ID, pausedArrivalOrNull } from '@services/aiService';
import { subscribe } from '@services/events';
import { EMPTY_SEED, type MemoryFeature, currentSeed } from '@services/memory';
import { type Result, err, ok } from '../types/result';

/** Waits for the work, or for the time limit; true when the work came first. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), limit]);
  } finally {
    clearTimeout(timer);
  }
}

type Arrival = { userId: string; threadId: string; messageId: string };

/**
 * Whether the capture of the segment the arrival's fire closed has
 * settled: it landed, or it gave up and its Facts stay owed. Waits for it,
 * up to the handover's wait, and queues it when none is under way. A
 * capture already queued or running is waited on as it is, so asking
 * again never restarts its attempts, and one that gave up is not tried
 * again here. Listening starts first, so a capture finishing meanwhile is
 * still heard; news lost between backend copies is caught by looking at
 * the capture again when the wait runs out. No closed segment on record
 * means nothing to wait for.
 */
async function closedSegmentCaptureSettled(
  memory: Extract<MemoryFeature, { kind: 'on' }>,
  { userId, threadId, messageId }: Arrival,
): Promise<boolean> {
  const logged = await findSegmentDriftLogByMessageId({ messageId, modelId: EMBEDDING_MODEL_ID });
  if (!logged) return true;
  const { segmentId } = logged;

  let heard: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    heard = resolve;
  });
  const subscription = subscribe(userId, (event) => {
    const captureSettled =
      event.kind === 'memory-captured' || event.kind === 'memory-capture-failed';
    if (captureSettled && event.segmentId === segmentId) heard();
  });
  try {
    await subscription.ready;
    const job = await memory.findMemoryCaptureSegmentJobOrNull(segmentId);
    if (job?.state === 'dead') return true;
    if (job === null) await memory.enqueueMemoryCaptureSegment({ userId, threadId, segmentId });
    if (await settledWithin(settled, env.HANDOVER_WAIT_MS)) return true;
    // A finished capture leaves no job behind; a dead one gave up.
    const after = await memory.findMemoryCaptureSegmentJobOrNull(segmentId);
    return after === null || after.state === 'dead';
  } finally {
    subscription.close();
  }
}

type HandOverArrivalProps = Arrival & { memory: MemoryFeature };

/**
 * Moves a paused arrival out of its Thread into a fresh one. With Memory
 * on, the segment the arrival closed is captured first, so the fresh
 * Thread's Seed knows what the segment taught: while that capture is still
 * running the handover answers `capture_pending` and moves nothing, and
 * asking again picks up the same capture. Only a capture that gave up
 * lets the move go ahead without it; its Facts stay owed for later
 * Threads. The move itself is one transaction: the arrival is abandoned in
 * place, and the fresh Thread opens with its Seed — empty without Memory —
 * and the arrival as its stored first message, still awaiting its reply.
 * Either all of that happens or none of it, and only one handover can win.
 */
export async function handOverArrival({
  userId,
  threadId,
  messageId,
  memory,
}: HandOverArrivalProps): Promise<Result<MovedArrival>> {
  const thread = await findThreadByIdAndUser({ userId, threadId });
  if (!thread) return err('thread_not_found');

  const paused = await pausedArrivalOrNull(await listMessagesByThread({ threadId }));
  if (paused?.id !== messageId) {
    return err('arrival_not_paused', 'Only the paused last message can start a new chat.');
  }

  if (
    memory.kind === 'on' &&
    !(await closedSegmentCaptureSettled(memory, { userId, threadId, messageId }))
  ) {
    return err('capture_pending', 'Still saving what this chat taught. Try again shortly.');
  }
  const moved = await moveArrivalToFreshThreadOrNull({
    userId,
    fromThreadId: threadId,
    messageId,
    seed: memory.kind === 'on' ? await currentSeed({ userId }) : EMPTY_SEED,
  });
  if (!moved) {
    return err('arrival_not_paused', 'The message was already answered or moved.');
  }
  return ok(moved);
}
