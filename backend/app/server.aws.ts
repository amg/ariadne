// AWS production entry point — ECS/Fargate deployment.
// Always runs as API-only; the worker is a separate service.
// Requires Redis (Valkey) for multi-copy coordination (event bus).
// Rate limiting is handled at the edge (Cloudflare), not in-memory.
// Must be the first import: loads the repo-root .env before any module
// reads process.env (db.ts resolves the connection at import time).
import '@config/dotenv';
import { featureFlags } from '@config/features';
import { seedDefaultUser } from '@services/userService';
import { logger } from '../src/logger';
import { stopOnSignals } from './lifecycle';
import { joinOtherCopiesOrNull } from './otherCopies';
import { createApp } from './server.common';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';

// CORS: AWS production requires explicit origins (no localhost defaults).
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (corsOrigins.length === 0) {
  throw new Error('CORS_ORIGINS is required for AWS deployment');
}

const start = async () => {
  try {
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
    logger.info({ features }, 'feature toggles read');

    stopOnSignals(async () => {
      await redis?.close();
    });

    await app.listen({ port: PORT, host: HOST });
    logger.info(`Server is running on http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  } catch (err) {
    logger.error({ err }, 'server failed to start');
    process.exit(1);
  }
};

start();
