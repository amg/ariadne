// Must be the first import: loads the repo-root .env before any module
// reads process.env (db.ts resolves the connection at import time).
import '@config/dotenv';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { startQueue, stopQueue } from '@queue/index';
import { setupChatPostRoute } from '@routes/chat';
import { setupConfigRoute } from '@routes/config';
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
import { seedDefaultUser } from '@services/userService';
import Fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../src/logger';

import { initAuth } from '@services/authService';
import supertokens from 'supertokens-node';
import { errorHandler, plugin } from 'supertokens-node/framework/fastify';

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

// CORS: locked to this app's frontend origins. `origin: true` used to reflect
// ANY origin, letting arbitrary sites drive-by the API. Requests without an
// Origin header (curl, the vite dev proxy, server-to-server) are unaffected.
// Override via CORS_ORIGINS (comma-separated) for other deployment origins.
const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const configuredOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.register(cors, {
  origin: configuredOrigins.length > 0 ? configuredOrigins : DEFAULT_ORIGINS,
  allowedHeaders: ['Content-Type', ...supertokens.getAllCORSHeaders()],
  credentials: true,
});

// Standard security headers on API responses.
app.register(helmet);

// SuperTokens auth routes (must be awaited - registers /auth/* routes)
await app.register(plugin);
app.setErrorHandler(errorHandler());

// Coarse global limit (amp + abuse); the billable chat route tightens its own
// window via route `config.rateLimit`. Local dev stayed comfortably under both.
// NOTE: must be awaited — @fastify/rate-limit wires routes via onRoute hooks,
// which are skipped for routes bound before the plugin finishes registering.
await app.register(rateLimit, { global: true, max: 100, timeWindow: '1 minute' });

// Register routes
setupHealthRoute(app);
setupConfigRoute(app);
setupThreadsGetRoute(app);
setupThreadsPostRoute(app);
setupThreadsGenerateTitleRoute(app);
setupThreadsPatchRoute(app);
setupThreadsDeleteRoute(app);
setupThreadSummaryRoute(app);
setupThreadAnalysisRoute(app);
setupMessagesGetRoute(app);
setupMessagesPatchRoute(app);
setupModelsRefreshRoute(app);
setupChatPostRoute(app);
setupThreadStopRoute(app);
setupThreadDraftRoute(app);
setupThreadHandoverRoute(app);
setupThreadCaptureMemoryRoute(app);
setupSettingsGetRoute(app);
setupSettingsPatchRoute(app);
setupMemoryFactsGetRoute(app);
setupMemoryFactsPatchRoute(app);
setupMemoryFactsDeleteRoute(app);

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';

/** Lets running background jobs finish before the process exits. */
function stopOnSignal(signal: NodeJS.Signals) {
  process.once(signal, () => {
    logger.info(`${signal} received, stopping the queue`);
    void stopQueue()
      .catch((error: unknown) => logger.error({ err: error }, 'queue did not stop cleanly'))
      .finally(() => process.exit(0));
  });
}

const start = async () => {
  try {
    await seedDefaultUser();
    await startQueue();
    stopOnSignal('SIGINT');
    stopOnSignal('SIGTERM');
    await app.listen({ port: PORT, host: HOST });
    logger.info(`Server is running on http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
