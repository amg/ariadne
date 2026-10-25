import { ok } from '../../../types/result';
import type { JudgingMode } from '../types';
import { embedMessageStep } from './embedMessageStep';
import type { MessageStepInput } from './messageStep';
import { rewriteMessageStep } from './rewriteMessageStep';
import { verdictAndFoldStep } from './verdictAndFoldStep';

/**
 * The message transformer: runs the live-lane pipeline for one arriving
 * user message. Steps are ordered rewrite → embed → verdict-and-fold, each
 * handed the chain the previous one returned; the runner's
 * responsibilities are ordering and stopping at the first error. Success
 * carries the chain with the arrival's verdict on it.
 */

/** Ordered steps; adding or removing a step happens here and nowhere else. */
function messageSteps(mode: JudgingMode) {
  return [rewriteMessageStep(mode), embedMessageStep, verdictAndFoldStep];
}

export async function transformMessage({
  chain,
  arrivalIndex,
  mode,
}: MessageStepInput & { mode: JudgingMode }) {
  let current = chain;
  for (const step of messageSteps(mode)) {
    const ran = await step.run({ chain: current, arrivalIndex });
    if (ran.type === 'error') return ran;
    current = ran.data;
  }
  return ok(current);
}
