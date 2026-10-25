import { env } from '@config/env';

/** The deployment's flags; anything unset keeps its default. */
export function featureFlags() {
  return { memory: env.FEATURE_MEMORY, threadAnalysisMode: env.THREAD_ANALYSIS_MODE };
}
