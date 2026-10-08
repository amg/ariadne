import { env } from '@config/env';
import { withThreadLock } from '@queries/locks/withThreadLock';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { type Result, err, ok } from '../../types/result';
import { buildLiveTurns } from './messageTransformer/liveTurns';
import { transformMessage } from './messageTransformer/transformMessage';
import type { FireChannel, GateVerdict } from './types';

/**
 * The live lane of the thread-health gate. Every arriving user message
 * runs through the message transformer — its rewrite try, its embed, and
 * its verdict against the live ledger — and the lane persists as it goes:
 * threads that predate the feature, a failure recovery, and a re-fill
 * after a message edit are all the lane resuming where the persisted
 * arrivals stop. Each transformer step persists as it completes, so
 * stored rows are replayed, never re-embedded or re-judged.
 */

export interface LiveArrivalOutcome {
  /** Verdict on the last processed arrival; null when nothing arrived. */
  verdict: GateVerdict | null;
  fireChannel: FireChannel | null;
  slowDriftStartMessageId: string | null;
  /** The user Message the last arrival landed on; null when nothing arrived. */
  messageId: string | null;
}

type RunLiveGateProps = {
  threadId: string;
  /**
   * Judge arrivals up to and including this user Message. Absent =
   * process every arrival in the thread (backfill / analysis-view fill).
   */
  upToMessageId?: string;
};

/** The outcome the lane reports before any arrival transformed. */
const EMPTY_OUTCOME: LiveArrivalOutcome = {
  verdict: null,
  fireChannel: null,
  slowDriftStartMessageId: null,
  messageId: null,
};

/**
 * The live lane's entry: gate the thread's arrivals up to (and including)
 * the target Message, or fill the whole thread when no target is given.
 * Off means no pass runs and the caller sees the empty outcome.
 *
 * Passes on one thread run strictly one at a time, wherever they run:
 * each pass snapshots the arrivals at its start, so two overlapping passes
 * would re-judge and re-log what the other writes after its snapshot. The
 * later pass re-reads the store, finds the arrivals done, and degrades to
 * a pure read.
 */
export async function runLiveGate({
  threadId,
  upToMessageId,
}: RunLiveGateProps): Promise<Result<LiveArrivalOutcome>> {
  if (env.THREAD_ANALYSIS_MODE === 'off') return ok(EMPTY_OUTCOME);
  return withThreadLock({ threadId, kind: 'live-chain' }, () =>
    transformArrivals(upToMessageId === undefined ? { threadId } : { threadId, upToMessageId }),
  );
}

/**
 * The fill-forward pass: transforms the thread's user Messages in
 * chronology up to (and including) the target. Each arrival's steps
 * short-circuit on their own stored rows, so a thread that is already
 * done degrades to a pure read and a broken one resumes where it stopped.
 *
 * Failure codes: `thread_not_found` (empty/unknown thread), plus any
 * step failure (`provider_not_configured`, `embed_failed`,
 * `arrival_signal_missing`, `thread_analysis_failed`) which the chat
 * route surfaces as a failed exchange.
 */
async function transformArrivals({
  threadId,
  upToMessageId,
}: RunLiveGateProps): Promise<Result<LiveArrivalOutcome>> {
  // Fresh read at pass start: the lane may run after the store has
  // advanced between the caller's request and its turn under the lock.
  if (env.THREAD_ANALYSIS_MODE === 'off') return ok(EMPTY_OUTCOME);
  const rows = await listMessagesByThread({ threadId });
  // Only the live conversation is gated; abandoned rows keep what they had.
  const arrivals = buildLiveTurns(rows.filter((row) => !row.abandoned));
  if (arrivals.length === 0) return ok(EMPTY_OUTCOME);

  let endIndex = arrivals.length;
  if (upToMessageId !== undefined) {
    const index = arrivals.findIndex((turn) => turn.userMessage.id === upToMessageId);
    if (index < 0) return err('thread_not_found');
    endIndex = index + 1;
  }

  let outcome: LiveArrivalOutcome = EMPTY_OUTCOME;
  for (let i = 0; i < endIndex; i += 1) {
    const arrival = arrivals[i];
    if (!arrival) continue;
    const transformed = await transformMessage({
      threadId,
      userMessageId: arrival.userMessage.id,
    });
    if (transformed.type === 'error') return transformed;
    outcome = transformed.data;
  }
  return ok(outcome);
}
