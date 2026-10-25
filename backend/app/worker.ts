// Must be the first import: loads the repo-root .env before any module
// reads process.env (db.ts resolves the connection at import time).
import '@config/dotenv';
import { env } from '@config/env';
import { featureFlags } from '@config/features';
import { databaseConnections } from '@db/db';
import { oldestDueJobWaitMs } from '@queries/queue/oldestDueJobWaitMs';
import { workerSlots } from '@queue/busySlots';
import { startQueue, stopQueue } from '@queue/index';
import { runnableTaskNames } from '@queue/worker';
import { takeCarrierFailures } from '@services/events';
import { learnCopyName } from '../src/appRecords/copyName';
import { measureProcess } from '../src/appRecords/processMeasures';
import { keepLoggingState } from '../src/appRecords/stateLog';
import { logger } from '../src/logger';
import { stopOnSignals } from './lifecycle';
import { memoryFeatureOf } from './memoryFeature';
import { joinOtherCopiesOrNull, requireRedisWhenSplit } from './otherCopies';

/**
 * The background worker as a process of its own, apart from the API: it
 * works the queue and sends its news to the API copies through Redis.
 * Any number may run side by side. A deployment running the API with
 * PROCESS_ROLE=all needs none.
 */
const start = async () => {
  try {
    if (env.PROCESS_ROLE !== 'worker') {
      throw new Error(`app/worker.ts runs with PROCESS_ROLE=worker, got ${env.PROCESS_ROLE}`);
    }
    requireRedisWhenSplit();
    await learnCopyName();
    const redis = await joinOtherCopiesOrNull();
    // Feature toggles are read once, here: changing one takes a restart.
    const features = featureFlags();
    const memory = memoryFeatureOf(features);
    const queueFeatures = { memory, threadAnalysisMode: features.threadAnalysisMode };
    await startQueue(queueFeatures);
    logger.info({ features, role: env.PROCESS_ROLE }, 'queue worker running');
    const stopLoggingState = keepLoggingState({
      ...measureProcess(),
      databaseConnections,
      workerSlots,
      pushBusFailures: takeCarrierFailures,
      oldestJobWaitMs: (limit) =>
        oldestDueJobWaitMs({
          tasks: runnableTaskNames(queueFeatures),
          ...limit,
        }),
    });
    stopOnSignals(async () => {
      stopLoggingState();
      await stopQueue();
      await redis?.close();
    });
  } catch (error) {
    logger.error({ err: error }, 'queue worker failed to start');
    process.exit(1);
  }
};

start();
