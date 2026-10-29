import type { FireChannel, GateVerdict } from '@ari/lib/api/schemas/common/driftGate';
import type { ThreadAnalysisMode } from '@ari/lib/api/schemas/threads/analysis';
import { type Result, err, ok } from '../../types/result';
import { isArrivalFinished, readLiveChain } from './messageTransformer/liveChain';
import { transformMessage } from './messageTransformer/transformMessage';
import type { JudgingMode, LiveChain } from './types';

/**
 * The live lane of the thread-health gate. Every arriving user message
 * runs through the message transformer — its rewrite try, its embed, and
 * its verdict against the current segment's Gravity point — and the lane
 * persists as it goes: threads that predate the feature, a failure
 * recovery, and a re-fill after a message edit are all the lane resuming
 * where the persisted arrivals stop. Each transformer step persists as it
 * completes, so stored rows are replayed, never re-embedded or
 * re-judged.
 */

interface LiveArrivalOutcome {
  /** Verdict on the last processed arrival; null when nothing arrived. */
  verdict: GateVerdict | null;
  fireChannel: FireChannel | null;
  slowDriftStartMessageId: string | null;
  /** The user Message the last arrival landed on; null when nothing arrived. */
  messageId: string | null;
}

type RunLiveGateProps = {
  threadId: string;
  /** The deployment's mode; `off` runs no pass. */
  mode: ThreadAnalysisMode;
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
 * Passes on one thread may overlap. Each arrival's judgment is stored by
 * whichever pass gets there first, and every pass reports what is stored,
 * so overlapping passes agree on every verdict; the loser only pays for a
 * duplicate round of inference.
 */
export async function runLiveGate({ threadId, upToMessageId, mode }: RunLiveGateProps) {
  if (mode === 'off') return ok(EMPTY_OUTCOME);
  return transformArrivals(
    upToMessageId === undefined ? { threadId, mode } : { threadId, upToMessageId, mode },
  );
}

/**
 * Whether the transformer still owes the arrival anything. A judged
 * arrival whose Turn still waits to fold is left to the next arrival's
 * judgment, which folds it in the same rebuild, unless it is the last
 * arrival this pass judges.
 */
function owesWork(chain: LiveChain, index: number, targetIndex: number) {
  const arrival = chain.arrivals[index];
  if (!arrival || isArrivalFinished(chain, arrival)) return false;
  return index === targetIndex || !chain.verdicts.has(arrival.userMessage.id);
}

/**
 * The fill-forward pass: reads the thread's live chain once, then
 * transforms the user Messages that still owe work, in chronology, up to
 * (and including) the target. Finished arrivals cost nothing, so a thread
 * that is already done degrades to a fixed handful of reads and a broken
 * one resumes where it stopped.
 *
 * Failure codes: `arrival_not_live` (the target is not a live arrival:
 * abandoned, or never one), plus any step failure (`provider_not_configured`, `embed_failed`,
 * `arrival_signal_missing`, `thread_analysis_failed`) which the chat
 * route surfaces as a failed exchange.
 */
async function transformArrivals({
  threadId,
  upToMessageId,
  mode,
}: Omit<RunLiveGateProps, 'mode'> & { mode: JudgingMode }): Promise<Result<LiveArrivalOutcome>> {
  // Only the live conversation is gated; abandoned rows keep what they had.
  const chain = await readLiveChain(threadId);
  if (chain.arrivals.length === 0) return ok(EMPTY_OUTCOME);

  const targetIndex =
    upToMessageId === undefined
      ? chain.arrivals.length - 1
      : chain.arrivals.findIndex((turn) => turn.userMessage.id === upToMessageId);
  const target = chain.arrivals[targetIndex];
  if (!target) return err('arrival_not_live');

  let current = chain;
  for (let i = 0; i <= targetIndex; i += 1) {
    if (!owesWork(current, i, targetIndex)) continue;
    const transformed = await transformMessage({
      chain: current,
      arrivalIndex: i,
      mode,
    });
    if (transformed.type === 'error') return transformed;
    current = transformed.data;
  }

  const logged = current.verdicts.get(target.userMessage.id);
  if (!logged) {
    return err(
      'thread_analysis_failed',
      'The transformer finished without recording a verdict for the arriving message.',
    );
  }
  return ok({
    verdict: logged.verdict,
    fireChannel: logged.fireChannel,
    slowDriftStartMessageId: logged.slowDriftStartMessageId,
    messageId: target.userMessage.id,
  });
}
