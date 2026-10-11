// Must be the first import: loads the repo-root .env before any module
// reads process.env (db.ts resolves the connection at import time).
import '@config/dotenv';
import { env } from '@config/env';
import { featureFlags } from '@config/features';
import { startQueue, stopQueue } from '@queue/index';
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
    const redis = await joinOtherCopiesOrNull();
    // Feature toggles are read once, here: changing one takes a restart.
    const features = featureFlags();
    await startQueue({ memory: memoryFeatureOf(features) });
    logger.info({ features, role: env.PROCESS_ROLE }, 'queue worker running');
    stopOnSignals(async () => {
      await stopQueue();
      await redis?.close();
    });
  } catch (error) {
    logger.error({ err: error }, 'queue worker failed to start');
    process.exit(1);
  }
};

start();
