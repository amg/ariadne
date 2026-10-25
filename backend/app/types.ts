import type { ThreadAnalysisMode } from '@ari/lib/api/schemas/threads/analysis';

/**
 * The deployment's boot-time choices: which features exist and how far
 * the Drift gate runs. Read once at boot by the server, which decides from
 * them what to register and hands the decisions down as values; the browser
 * learns the same choices from `/api/config`.
 */
export interface FeatureFlags {
  /** Fact capture, Thread Seeds, and the Memory screen and settings. */
  memory: boolean;
  /** How far the Drift gate runs; `off` judges nothing. */
  threadAnalysisMode: ThreadAnalysisMode;
}
