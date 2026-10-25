import { z } from 'zod';
import type { Limits } from '../types/criteria.ts';
import { UnknownCriteria, sizeOfLoad } from './criterion.ts';
import { HOME_LINES } from './home.ts';
import { sizedLines } from './sized.ts';

const stepConfig = z.object({
  load: z.object({ users: z.number(), chattingShare: z.number() }),
});

/**
 * Smoke is the smallest aws-prod run, and it proves the tools rather than
 * the stack. It sets no limits on what users saw. It passes when its
 * records are whole and agree with each other, and it ran its plan to the
 * end.
 */
const SMOKE_LIMITS: Limits = {};

/**
 * The limits a new run of a step records; null for a
 * step that has none yet, which a rebuild names as not judged. The limits
 * of step10 and step50 follow the step's size, and are worked out from the
 * users and share of chatters its `config` gives.
 */
export function limitsFor(step: string, config: Readonly<Record<string, unknown>>) {
  if (step.startsWith('home-')) return HOME_LINES;
  if (step === 'smoke') return SMOKE_LIMITS;
  if (step !== 'step10' && step !== 'step50') return null;
  const parsed = stepConfig.safeParse(config);
  if (!parsed.success) {
    throw new UnknownCriteria(
      `The limits of ${step} cannot be worked out: its configuration does not give its users and its share of chatters`,
    );
  }
  return sizedLines(sizeOfLoad(parsed.data.load));
}
