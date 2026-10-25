import { z } from 'zod';

/**
 * The step configuration a run is given. The load a run plans, and the
 * share of users who chat, must be there; everything else the step holds
 * is kept as it came, so the run's record has the whole configuration.
 */
const stepConfigSchema = z
  .object({
    load: z
      .object({
        generators: z.number().int().positive(),
        spot: z.boolean(),
        users: z.number().int().nonnegative(),
        chattingShare: z.number().min(0).max(1),
        rampSeconds: z.number().nonnegative(),
        holdSeconds: z.number().nonnegative(),
        thinkSeconds: z.number().nonnegative(),
      })
      .loose(),
  })
  .loose();

/** The configuration in the text; throws, saying which field is wrong, when the text is not one. */
export function parseStepConfig(text: string) {
  const parsed = stepConfigSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`The step configuration is not usable:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
