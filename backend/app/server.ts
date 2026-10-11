// Home server entry point — dev, staging, and prod (docker-compose).
// Runs as a single process (API + queue worker together), no Redis required.
// Must be the first import: loads the repo-root .env before any module
// reads process.env (db.ts resolves the connection at import time).
import '@config/dotenv';
import { featureFlags } from '@config/features';
import { startQueue, stopQueue } from '@queue/index';
import { seedDefaultUser } from '@services/userService';
import { logger } from '../src/logger';
import { stopOnSignals } from './lifecycle';
import { memoryFeatureOf } from './memoryFeature';
import { createApp } from './server.common';

// Home server always runs as a single process — API and queue together.
// Redis is optional (used only for multi-copy staging setups).
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';

// CORS: localhost defaults for home deployments.
const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const configuredOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const corsOrigins = configuredOrigins.length > 0 ? configuredOrigins : DEFAULT_ORIGINS;

const start = async () => {
  try {
    // Feature toggles are read once, here: changing one takes a restart.
    const features = featureFlags();
    const app = await createApp(features, {
      corsOrigins,
      enableRateLimiting: true,
    });

    await seedDefaultUser();
    await startQueue({ memory: memoryFeatureOf(features) });
    logger.info({ features, role: 'all' }, 'feature toggles read');

    stopOnSignals(async () => {
      await stopQueue();
    });

    await app.listen({ port: PORT, host: HOST });
    logger.info(`Server is running on http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  } catch (err) {
    logger.error({ err }, 'server failed to start');
    process.exit(1);
  }
};

start();
