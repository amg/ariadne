// AWS production entry point — ECS/Fargate deployment.
// Always runs as API-only; the worker is a separate service.
// Requires Redis (Valkey) for multi-copy coordination (event bus).
// Rate limiting is handled at the edge (Cloudflare), not in-memory.
// Must be the first import: loads the repo-root .env before any module
// reads process.env (db.ts resolves the connection at import time).
import '@config/dotenv';
import { env } from '@config/env';
import { featureFlags } from '@config/features';
import { databaseConnections } from '@db/db';
import { takeCarrierFailures } from '@services/events';
import { seedDefaultUser } from '@services/userService';
import { learnCopyName } from '../src/appRecords/copyName';
import { measureProcess } from '../src/appRecords/processMeasures';
import { keepLoggingState } from '../src/appRecords/stateLog';
import { logger } from '../src/logger';
import { stopOnSignals } from './lifecycle';
import { joinOtherCopiesOrNull } from './otherCopies';
import { pushStreamsOpen } from './pushStreams';
import { createApp } from './server.common';

// CORS: AWS production requires explicit origins (no localhost defaults).
const corsOrigins = env.CORS_ORIGINS;
if (corsOrigins.length === 0) {
  throw new Error('CORS_ORIGINS is required for AWS deployment');
}

const start = async () => {
  try {
    await learnCopyName();
    // Feature toggles are read once, here: changing one takes a restart.
    const features = featureFlags();
    const app = await createApp(features, {
      corsOrigins,
      enableRateLimiting: false, // Cloudflare edge handles rate limiting
    });

    // AWS always runs multiple copies — Redis is required for the event bus.
    // This acts as a health check: fail fast if Redis is not available.
    const redis = await joinOtherCopiesOrNull();
    if (redis === null) {
      throw new Error('VALKEY_URL is required for AWS deployment (multi-copy event bus)');
    }

    await seedDefaultUser();
    // Read at boot so a malformed budget stops startup instead of failing each chat.
    logger.info(
      { features, dailySpendBudgetUsd: env.DAILY_SPEND_BUDGET_USD },
      'feature toggles read',
    );
    const stopLoggingState = keepLoggingState({
      ...measureProcess(),
      pushStreamsOpen,
      databaseConnections,
      pushBusFailures: takeCarrierFailures,
    });

    stopOnSignals(async () => {
      stopLoggingState();
      await redis?.close();
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
