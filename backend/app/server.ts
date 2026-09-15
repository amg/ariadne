// Must be the first import: loads backend/.env before any module reads
// process.env (db.ts resolves the connection at import time).
import 'dotenv/config';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { setupChatPostRoute } from '@routes/chat';
import { setupHealthRoute } from '@routes/health/get';
import { setupMessagesGetRoute, setupMessagesPatchRoute } from '@routes/messages';
import { setupModelsRefreshRoute } from '@routes/models';
import {
  setupThreadSummaryRoute,
  setupThreadsDeleteRoute,
  setupThreadsGetRoute,
  setupThreadsPatchRoute,
  setupThreadsPostRoute,
} from '@routes/threads';
import { seedDefaultUser } from '@services/userService';
import Fastify from 'fastify';

const app = Fastify({ logger: true });

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
});

// Standard security headers on API responses.
app.register(helmet);

// Coarse global limit (amp + abuse); the billable chat route tightens its own
// window via route `config.rateLimit`. Local dev stayed comfortably under both.
// NOTE: must be awaited — @fastify/rate-limit wires routes via onRoute hooks,
// which are skipped for routes bound before the plugin finishes registering.
await app.register(rateLimit, { global: true, max: 100, timeWindow: '1 minute' });

// Register routes
setupHealthRoute(app);
setupThreadsGetRoute(app);
setupThreadsPostRoute(app);
setupThreadsPatchRoute(app);
setupThreadsDeleteRoute(app);
setupThreadSummaryRoute(app);
setupMessagesGetRoute(app);
setupMessagesPatchRoute(app);
setupModelsRefreshRoute(app);
setupChatPostRoute(app);

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';

const start = async () => {
  try {
    await seedDefaultUser();
    await app.listen({ port: PORT, host: HOST });
    console.log(`Server is running on http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
