import type { Result } from '../../../types/result';
import type { LiveChain } from '../types';

/**
 * One step of the message transformer. A step reads its inputs from the
 * pass's live chain, persists its own outputs, and returns the chain with
 * what it stored, so later steps never read those rows again. Order and
 * failure semantics belong to the caller; this interface changes nothing
 * when steps are added or removed.
 */
export interface MessageStep {
  /** The step's identifier; the caller decides ordering. */
  name: string;
  /**
   * Success carries the chain with whatever the step stored (the same
   * chain when it had nothing to do). Failure means the step could not
   * complete; the caller surfaces that to the exchange. Each concrete
   * step documents whether it can fail open or must hard-fail.
   */
  run(input: MessageStepInput): Promise<Result<LiveChain>>;
}

export interface MessageStepInput {
  chain: LiveChain;
  /** Position in the whole live chain of the user Message the step processes. */
  arrivalIndex: number;
}
