import type { FeatureFlags } from '@config/features';
import { setupChatPostRoute } from '@routes/chat';
import { setupConfigRoute } from '@routes/config';
import { setupEventsGetRoute } from '@routes/events/get';
import { setupHealthRoute } from '@routes/health/get';
import { setupMessagesGetRoute, setupMessagesPatchRoute } from '@routes/messages';
import { setupModelsRefreshRoute } from '@routes/models';
import {
  setupMemoryFactsDeleteRoute,
  setupMemoryFactsGetRoute,
  setupMemoryFactsPatchRoute,
  setupSettingsGetRoute,
  setupSettingsPatchRoute,
} from '@routes/settings';
import {
  setupThreadAnalysisRoute,
  setupThreadCaptureMemoryRoute,
  setupThreadDraftRoute,
  setupThreadHandoverRoute,
  setupThreadStopRoute,
  setupThreadSummaryRoute,
  setupThreadsDeleteRoute,
  setupThreadsGenerateTitleRoute,
  setupThreadsGetRoute,
  setupThreadsPatchRoute,
  setupThreadsPostRoute,
} from '@routes/threads';
import type { FastifyInstance } from 'fastify';
import { memoryFeatureOf } from './memoryFeature';

/**
 * The routes of Memory: the user's settings (all of them about Memory),
 * their Facts, and the on-demand capture. A deployment without Memory
 * does not serve them at all.
 */
function registerMemoryRoutes(app: FastifyInstance): void {
  setupThreadCaptureMemoryRoute(app);
  setupSettingsGetRoute(app);
  setupSettingsPatchRoute(app);
  setupMemoryFactsGetRoute(app);
  setupMemoryFactsPatchRoute(app);
  setupMemoryFactsDeleteRoute(app);
}

/** Every route the deployment serves, given which features it runs. */
export function registerRoutes(app: FastifyInstance, features: FeatureFlags): void {
  const memory = memoryFeatureOf(features);
  setupHealthRoute(app);
  setupConfigRoute(app, features);
  setupEventsGetRoute(app);
  setupThreadsGetRoute(app);
  setupThreadsPostRoute(app, { memory });
  setupThreadsGenerateTitleRoute(app);
  setupThreadsPatchRoute(app);
  setupThreadsDeleteRoute(app);
  setupThreadSummaryRoute(app);
  setupThreadAnalysisRoute(app);
  setupMessagesGetRoute(app);
  setupMessagesPatchRoute(app);
  setupModelsRefreshRoute(app);
  setupChatPostRoute(app, { memory });
  setupThreadStopRoute(app);
  setupThreadDraftRoute(app);
  setupThreadHandoverRoute(app, { memory });
  if (memory.kind === 'on') registerMemoryRoutes(app);
}
