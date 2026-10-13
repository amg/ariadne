import { type Result, ok } from '../../../types/result';
import { embedMessageStep } from './embedMessageStep';
import type { LiveChain } from './liveChain';
import type { MessageStep, MessageStepInput } from './messageStep';
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
const MESSAGE_STEPS: readonly MessageStep[] = [
  rewriteMessageStep,
  embedMessageStep,
  verdictAndFoldStep,
];

export async function transformMessage({
  chain,
  arrivalIndex,
}: MessageStepInput): Promise<Result<LiveChain>> {
  let current = chain;
  for (const step of MESSAGE_STEPS) {
    const ran = await step.run({ chain: current, arrivalIndex });
    if (ran.type === 'error') return ran;
    current = ran.data;
  }
  return ok(current);
}
