// Shared server setup for both home and AWS deployments.
// Exports a configured Fastify instance and common initialization logic.
import type { FeatureFlags } from '@config/features';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../src/logger';
import { registerRateLimits } from './rateLimits';
import { registerRoutes } from './registerRoutes';

import { initAuth } from '@services/authService';
import supertokens from 'supertokens-node';
import { errorHandler, plugin } from 'supertokens-node/framework/fastify';

// Initialize SuperTokens before any of its functions are used
initAuth();

/**
 * `disableRequestLogging` silences Fastify's per-request lines (the
 * onResponse hook below replaces them), but it also silences the error
 * log, so a 4xx raised before a handler runs (bad body, failed parse)
 * left only its status code behind. The reason is logged regardless.
 */
class AppLogController extends LogController {
  override defaultErrorLog(error: Error, _request: FastifyRequest, reply: FastifyReply): void {
    if (reply.statusCode >= 500) {
      reply.log.error({ err: error }, error.message);
    } else {
      reply.log.warn({ err: error }, error.message);
    }
  }
}

export type AppOptions = {
  /** CORS origins to allow. Required for production deployments. */
  corsOrigins: string[];
  /** Whether to enable in-memory rate limiting. False when edge (Cloudflare) handles it. */
  enableRateLimiting: boolean;
};

/**
 * Creates and configures the Fastify application instance with:
 * - Custom logging (single-line per request)
 * - CORS (configured for the deployment)
 * - Security headers (helmet)
 * - SuperTokens auth routes
 * - Rate limiting (optional - disabled when edge handles it)
 * - Application routes
 *
 * Callers are responsible for:
 * - Loading environment variables (.env)
 * - Starting/stopping the queue worker
 * - Managing Redis connections for multi-copy deployments
 * - Signal handling and graceful shutdown
 */
export async function createApp(
  features: FeatureFlags,
  options: AppOptions,
): Promise<FastifyInstance> {
  // ── Dev console — the logger singleton (`src/logger.ts`) renders one
  // scannable line per request via the onResponse hook below:
  //   POST /api/threads/…/generate-title → 502 5666ms
  // Docker/CI/captured logs (no TTY) keep plain JSON. With DEBUG=true the
  // titling exchange (prompt sent ▸ title returned) is logged too. ───────────
  const app = Fastify({
    // The singleton is a pino instance; fastify's route generics default to
    // FastifyBaseLogger, so project it once here (it structurally satisfies
    // the picked interface).
    loggerInstance: logger as FastifyBaseLogger,
    // Fastify's default per-request "incoming request"/"request completed" pair
    // is replaced by the single-line hook below (non-deprecated controller API).
    logController: new AppLogController({ disableRequestLogging: true }),
  });

  app.addHook('onResponse', (request, reply, done) => {
    reply.log.info(
      {
        req: { method: request.method, url: request.url },
        res: { statusCode: reply.statusCode },
        responseTime: reply.elapsedTime,
      },
      'request completed',
    );
    done();
  });

  // CORS: locked to this app's frontend origins.
  app.register(cors, {
    origin: options.corsOrigins,
    allowedHeaders: ['Content-Type', ...supertokens.getAllCORSHeaders()],
    credentials: true,
  });

  // Standard security headers on API responses.
  app.register(helmet);

  // SuperTokens auth routes (must be awaited - registers /auth/* routes)
  await app.register(plugin);
  app.setErrorHandler(errorHandler());

  // Rate limiting: in-memory only. Disabled in multi-copy deployments where
  // edge (Cloudflare) handles rate limiting by real client address.
  if (options.enableRateLimiting) await registerRateLimits(app);
  registerRoutes(app, features);

  return app;
}
