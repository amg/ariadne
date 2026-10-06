import { env } from '@config/env';

/**
 * Which features exist in this deployment. Read once at boot by the
 * server, which decides from it what to register and hands the decisions
 * down as values; the browser learns the same flags from `/api/config`.
 */
export interface FeatureFlags {
  /** Fact capture, Thread Seeds, and the Memory screen and settings. */
  memory: boolean;
}

/** The deployment's flags; anything unset keeps its default, which is off. */
export function featureFlags(): FeatureFlags {
  return { memory: env.FEATURE_MEMORY };
}
