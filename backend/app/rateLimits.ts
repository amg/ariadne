import { env } from '@config/env';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { rateLimitKey } from './rateLimitKey';

/** Where the auth provider answers sign-in, sign-up and session refresh. */
const AUTH_PATH_PREFIX = '/api/auth/';

/**
 * The auth routes are answered by a hook before any route matches, so the
 * route-level limit never reaches them; the app's limit is applied to
 * their paths directly.
 */
function limitAuthRoutes(app: FastifyInstance): void {
  // The plugin decorates the app with `rateLimit` at runtime, but its
  // typings leave it out (and augment the root workspace's copy of
  // fastify, not this one). It answers an exceeded limit by throwing the
  // same 429 the route-level limit sends.
  const limiting = app as unknown as {
    rateLimit(): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  };
  const limit = limiting.rateLimit();
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(AUTH_PATH_PREFIX)) return;
    await limit(request, reply);
  });
}

/**
 * The app's request limits: every route, and the auth routes unless the
 * edge limits those by the real client address. Each request counts
 * against its signed-in user, or else its client address. Counts are kept
 * in memory (single replica at home, Cloudflare edge limits in prod).
 * Register it before the routes it limits.
 */
export async function registerRateLimits(app: FastifyInstance): Promise<void> {
  // Coarse global limit (amp + abuse); the billable chat route tightens its own
  // window via route `config.rateLimit`. Counts are kept in memory for home
  // deployments; production uses Cloudflare edge limits instead.
  // NOTE: must be awaited — @fastify/rate-limit wires routes via onRoute hooks,
  // which are skipped for routes bound before the plugin finishes registering.
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
  });
  if (!env.AUTH_RATE_LIMIT_AT_EDGE) limitAuthRoutes(app);
}
