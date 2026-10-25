// Home server entry point — dev, staging, and prod (docker-compose).
// Runs as a single process (API + queue worker together), no Redis required.
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
import { seedDefaultUser } from '@services/userService';
import { learnCopyName } from '../src/appRecords/copyName';
import { measureProcess } from '../src/appRecords/processMeasures';
import { keepLoggingState } from '../src/appRecords/stateLog';
import { logger } from '../src/logger';
import { stopOnSignals } from './lifecycle';
import { memoryFeatureOf } from './memoryFeature';
import { pushStreamsOpen } from './pushStreams';
import { createApp } from './server.common';

// CORS: localhost defaults for home deployments.
const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const corsOrigins = env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : DEFAULT_ORIGINS;

const start = async () => {
  try {
    await learnCopyName();
    // Feature toggles are read once, here: changing one takes a restart.
    const features = featureFlags();
    const app = await createApp(features, {
      corsOrigins,
      enableRateLimiting: true,
    });

    await seedDefaultUser();
    const memory = memoryFeatureOf(features);
    const queueFeatures = { memory, threadAnalysisMode: features.threadAnalysisMode };
    await startQueue(queueFeatures);
    // Read at boot so a malformed budget stops startup instead of failing each chat.
    logger.info(
      { features, role: 'all', dailySpendBudgetUsd: env.DAILY_SPEND_BUDGET_USD },
      'feature toggles read',
    );
    const stopLoggingState = keepLoggingState({
      ...measureProcess(),
      pushStreamsOpen,
      databaseConnections,
      workerSlots,
      oldestJobWaitMs: (limit) =>
        oldestDueJobWaitMs({
          tasks: runnableTaskNames(queueFeatures),
          ...limit,
        }),
    });

    stopOnSignals(async () => {
      stopLoggingState();
      await stopQueue();
    });

    await app.listen({ port: env.PORT, host: env.HOST });
    logger.info(
      `Server is running on http://${env.HOST === '0.0.0.0' ? '127.0.0.1' : env.HOST}:${env.PORT}`,
    );
  } catch (err) {
    logger.error({ err }, 'server failed to start');
    process.exit(1);
  }
};

start();
