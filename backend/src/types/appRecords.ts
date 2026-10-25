import type { ExchangeOutcome, ExchangeVerdict } from '../appRecords/records';

/**
 * The log of one chat request, which writes its record once, when the
 * request ends. Every call is a log call: it says the request reached
 * that point.
 */
export type ExchangeLog = {
  /** The gate answered. Only the first answer counts, this or a replayed one. */
  logGateAnswered: (verdict: ExchangeVerdict) => void;
  /**
   * A retry found its verdict already stored and replayed it, so the gate
   * judged nothing for it. Only the first answer counts, this or the gate's.
   */
  logVerdictReplayed: (verdict: ExchangeVerdict) => void;
  /** A first token reached the reply. Only the first counts. */
  logFirstToken: () => void;
  /** The request ended. Only the first end writes the record. */
  logEnded: (
    outcome: ExchangeOutcome,
    details?: { errorCode?: string | null; assistantMessageId?: string | null },
  ) => void;
};
