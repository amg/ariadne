/**
 * Telemetry only: records a step the chat flow attempts without letting
 * its failure change what the exchange settles. Each warning names the
 * step and carries the error; nothing here retries a step, blocks a
 * settle or writes anything itself.
 */
import { logger } from '../../logger';

/** The words each step's warning carries; the flow passes the step it attempted. */
const STEP_WORDS = {
  settleReplyText: 'settle the reply text',
  persistEstimatedSpend: 'persist the estimated spend row',
  enqueueFoldTurn: 'enqueue the drift-gate fold turn',
} as const;

type BestEffortStep = keyof typeof STEP_WORDS;

/** Reports a best-effort step that failed, and lets the flow keep its outcome. */
export function logBestEffortFailure({ step, error }: { step: BestEffortStep; error: unknown }) {
  logger.warn({ err: error }, `could not ${STEP_WORDS[step]}`);
}
