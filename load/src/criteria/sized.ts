import { SHARES, SIGNALS, passLineOf } from '@ari/lib/metrics/catalogue';
import { type StepLoad, sizeOfLoad } from './criterion.ts';

type StepSize = ReturnType<typeof sizeOfLoad>;

/** The lines that do not depend on how big the step is. */
export const SIZED_FIXED_LINES = {
  maxFirstByteP95Ms: passLineOf(SIGNALS.load.chatFirstByteP95),
  maxGateWaitAtLimitShare: passLineOf(SHARES.gateWaitsAtLimit) / 100,
  maxSignInFailureShare: passLineOf(SHARES.signInFailures) / 100,
  maxGeneratorCpuPercent: passLineOf(SHARES.generatorCpuBusiest),
} as const;

/** The percent of a step's users, and of its chatters, that must be held through the hold. */
const HELD_PERCENT = 98;

/** The lines of a sized step of this size. */
export function sizedLines(size: StepSize) {
  return {
    minPushStreams: Math.floor((size.users * HELD_PERCENT) / 100),
    minChatters: Math.floor((size.chatters * HELD_PERCENT) / 100),
    ...SIZED_FIXED_LINES,
  };
}

/**
 * The load a sized step must hold, as its criteria set it, from the step's
 * users and share of them that chat.
 */
export function sizedLinesOfLoad(load: StepLoad) {
  return sizedLines(sizeOfLoad(load));
}
