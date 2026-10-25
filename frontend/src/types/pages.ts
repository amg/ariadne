import type { FeatureFlags } from '@/config/features';
import type { Thread, ThreadAnalysisMode } from '@/services/api';

/** What the app shell loads once per navigation: the sidebar's threads and the deployment's surfaces. */
export interface RootLoaderData {
  threads: Thread[];
  threadAnalysisMode: ThreadAnalysisMode;
  features: FeatureFlags;
}
