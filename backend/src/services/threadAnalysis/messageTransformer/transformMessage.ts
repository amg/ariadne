import { findSegmentDriftLogByMessageId } from '@queries/segmentDriftLogs/findSegmentDriftLogByMessageId';
import { type Result, err, ok } from '../../../types/result';
import { EMBEDDING_MODEL_ID } from '../../aiService';
import type { GateVerdict } from '../types';
import { embedMessageStep } from './embedMessageStep';
import type { MessageStep, MessageStepInput } from './messageStep';
import { rewriteMessageStep } from './rewriteMessageStep';
import { verdictAndFoldStep } from './verdictAndFoldStep';

/**
 * The message transformer: runs the live-lane pipeline for one arriving
 * user message. Steps are ordered rewrite → embed → verdict-and-fold,
 * communicate only through the database, and the runner's responsibilities
 * are ordering, stopping at the first error, and surfacing the recorded
 * verdict back to the caller.
 */

/** Ordered steps; adding or removing a step happens here and nowhere else. */
const MESSAGE_STEPS: readonly MessageStep[] = [
  rewriteMessageStep,
  embedMessageStep,
  verdictAndFoldStep,
];

export interface TransformOutcome {
  /** Verdict recorded on the target message by this run. */
  verdict: GateVerdict;
  fireChannel: 'immediate' | 'slow' | null;
  slowDriftStartMessageId: string | null;
  /** The user message this outcome belongs to. */
  messageId: string;
}

export async function transformMessage(input: MessageStepInput): Promise<Result<TransformOutcome>> {
  for (const step of MESSAGE_STEPS) {
    const ran = await step.run(input);
    if (ran.type === 'error') return ran;
  }
  const logged = await findSegmentDriftLogByMessageId({
    messageId: input.userMessageId,
    modelId: EMBEDDING_MODEL_ID,
  });
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
    messageId: input.userMessageId,
  });
}
