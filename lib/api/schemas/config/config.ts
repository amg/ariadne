import { z } from 'zod';
import { endpoint } from '../common/endpoint.ts';
import type { Wire } from '../common/wire.ts';
import { THREAD_ANALYSIS_MODES } from '../threads/analysis.ts';

/** Which features this deployment runs. */
export const featureFlagsSchema = z.object({
  /** Fact capture, Thread Seeds, and the Memory screen and settings. */
  memory: z.boolean(),
});
export type FeatureFlags = Wire<typeof featureFlagsSchema>;

/** What the deployment tells the app to show. */
export const appConfigSchema = z.object({
  threadAnalysisMode: z.enum(THREAD_ANALYSIS_MODES),
  features: featureFlagsSchema,
});
export type AppConfig = Wire<typeof appConfigSchema>;

export const getConfig = endpoint({
  method: 'GET',
  path: '/api/config',
  replies: { 200: appConfigSchema },
});
