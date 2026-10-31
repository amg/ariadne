// Shared server setup for both home and AWS deployments.
// Exports a configured Fastify instance and common initialization logic.
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { logRequestEnded } from '../src/appRecords/requestLog';
import { logger } from '../src/logger';
import { registerRateLimits } from './rateLimits';
import { registerRoutes } from './registerRoutes';

import { initAuth } from '@services/authService';
import supertokens from 'supertokens-node';
import { errorHandler, plugin } from 'supertokens-node/framework/fastify';
import type { FeatureFlags } from './types';

// Initialize SuperTokens before any of its functions are used
initAuth();

/**
 * Logs the reason for every error response. Fastify's request logging is
 * turned off below, and that also turns off its error log, so without this
 * a 4xx raised before a handler runs (bad body, failed parse) would leave
 * only its status code.
 */
class AppLogController extends LogController {
  // biome-ignore lint/complexity/useMaxParams: Fastify's LogController fixes this signature
  override defaultErrorLog(error: Error, _request: FastifyRequest, reply: FastifyReply): void {
    if (reply.statusCode >= 500) {
      reply.log.error({ err: error }, error.message);
    } else {
      reply.log.warn({ err: error }, error.message);
    }
  }
}

type AppOptions = {
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
export async function createApp(features: FeatureFlags, options: AppOptions) {
  const app = Fastify({
    // The logger is a pino instance; fastify's route generics expect
    // FastifyBaseLogger, which it structurally satisfies.
    loggerInstance: logger as FastifyBaseLogger,
    // The onResponse hook below writes one request record per request,
    // in place of Fastify's own request lines.
    logController: new AppLogController({ disableRequestLogging: true }),
  });

  app.addHook('onResponse', logRequestEnded);

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
