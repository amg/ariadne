import type { Result } from '../../../types/result';

/**
 * One step of the message transformer. Steps share no in-memory state:
 * each run receives the Message it must process, reads its own inputs
 * from the database, and persists its own outputs. Order and failure
 * semantics belong to the caller; this interface changes nothing when
 * steps are added or removed.
 */
export interface MessageStep {
  /** The step's identifier; the caller decides ordering. */
  name: string;
  /**
   * Success means the step persisted its output (or had nothing to do).
   * Failure means the step could not complete; the caller surfaces that
   * to the exchange. Each concrete step documents whether it can fail
   * open or must hard-fail.
   */
  run(input: MessageStepInput): Promise<Result<void>>;
}

export interface MessageStepInput {
  threadId: string;
  /** The arriving user Message the step processes. */
  userMessageId: string;
}
