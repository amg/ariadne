import { env } from '@config/env';
import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { type Result, err, ok } from '../../types/result';
import { buildLiveTurns } from './messageTransformer/liveTurns';
import { transformMessage } from './messageTransformer/transformMessage';
import type { GateVerdict } from './types';

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
  fireChannel: 'immediate' | 'slow' | null;
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
  /**
   * Maximum number of arrivals to process in one backfill pass.
   * Absent = no limit (process all). Used by the analysis route to
   * bound backfill to 20 arrivals per request.
   */
  limit?: number;
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
 * Off means no pass runs and the caller sees the empty outcome. Every
 * pass runs under per-thread serialization (see `runSequentially`).
 */
export async function runLiveGate({
  threadId,
  upToMessageId,
}: RunLiveGateProps): Promise<Result<LiveArrivalOutcome>> {
  if (env.THREAD_ANALYSIS_MODE === 'off') return ok(EMPTY_OUTCOME);
  return runSequentially(threadId, () =>
    transformArrivals(upToMessageId === undefined ? { threadId } : { threadId, upToMessageId }),
  );
}

/**
 * One backend serves every surface, but two surfaces call the gate at
 * once — the exchange judges up to its arrival while the analysis surface
 * backfills the thread. Each pass snapshots the arrivals at its start, so
 * overlapping passes re-judge and re-log arrivals the other writes after
 * the snapshot, duplicating rows. Passes on one thread therefore run
 * strictly serialized: the LATER pass re-reads the store, finds the
 * arrivals done, and degrades to a pure read.
 */
const runsByThread = new Map<string, Promise<unknown>>();

function runSequentially<T>(threadId: string, body: () => Promise<T>): Promise<T> {
  const previous = runsByThread.get(threadId) ?? Promise.resolve();
  let release!: () => void;
  const holding = new Promise<void>((resolve) => {
    release = resolve;
  });
  runsByThread.set(threadId, holding);
  // Even a failed pass hands the queue along intact.
  const run = previous.then(body, body);
  run.then(release, release);
  void run.finally(() => {
    if (runsByThread.get(threadId) === holding) runsByThread.delete(threadId);
  });
  return run;
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
 *
 * Bounded backfill: when `limit` is set, processes at most that many
 * arrivals per pass — leftovers catch up on the next read.
 */
async function transformArrivals({
  threadId,
  upToMessageId,
  limit,
}: RunLiveGateProps): Promise<Result<LiveArrivalOutcome>> {
  // Fresh read at pass start: the lane may run after the store has
  // advanced between the caller's request and its turn under the lock.
  if (env.THREAD_ANALYSIS_MODE === 'off') return ok(EMPTY_OUTCOME);
  const rows = await listMessagesByThread({ threadId });
  const arrivals = buildLiveTurns(rows);
  if (arrivals.length === 0) return ok(EMPTY_OUTCOME);

  let endIndex = arrivals.length;
  if (upToMessageId !== undefined) {
    const index = arrivals.findIndex((turn) => turn.userMessage.id === upToMessageId);
    if (index < 0) return err('thread_not_found');
    endIndex = index + 1;
  }

  // Apply backfill limit when set (analysis route).
  if (limit !== undefined && limit > 0) {
    // Count how many arrivals still need processing (not yet transformed).
    const processedCount = 0;
    const limitedEndIndex = Math.min(endIndex, limit);
    endIndex = limitedEndIndex;
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
