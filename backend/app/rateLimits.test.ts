import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerRateLimits } from './rateLimits';

const openApps: FastifyInstance[] = [];
const savedAtEdge = process.env.AUTH_RATE_LIMIT_AT_EDGE;

afterEach(async () => {
  process.env.AUTH_RATE_LIMIT_AT_EDGE = savedAtEdge ?? '';
  for (const app of openApps.splice(0)) await app.close();
});

/** Each test's own route, so its count starts from nothing. */
function freshRoute() {
  return `/api/limited-${randomUUID()}`;
}

/**
 * One backend copy's limits, with a route allowing `max` requests a minute,
 * and an auth hook answering `/api/auth/*` before any route matches, as
 * the auth provider does.
 */
async function copyWithLimits(route: string, { max }: { max: number }) {
  const app = Fastify({ logger: false });
  openApps.push(app);
  await registerRateLimits(app);
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/api/auth/')) await reply.send({ signedIn: true });
  });
  app.get(route, { config: { rateLimit: { max, timeWindow: '1 minute' } } }, async () => 'ok');
  await app.ready();
  return app;
}

async function statusOf(app: FastifyInstance, url: string, method: 'GET' | 'POST' = 'GET') {
  return (await app.inject({ url, method })).statusCode;
}

describe('rate limits in single-replica deployment', () => {
  it('holds the limit within one backend copy', async () => {
    const route = freshRoute();
    const app = await copyWithLimits(route, { max: 2 });

    expect(await statusOf(app, route)).toBe(200);
    expect(await statusOf(app, route)).toBe(200);
    expect(await statusOf(app, route)).toBe(429);
  });
});

describe('the auth routes', () => {
  /** The global limit, which the auth routes share with every route of no limit of its own. */
  const GLOBAL_MAX = 100;

  it('are limited by the app unless the edge limits them', async () => {
    process.env.AUTH_RATE_LIMIT_AT_EDGE = '';
    const app = await copyWithLimits(freshRoute(), { max: 1 });

    for (let i = 0; i < GLOBAL_MAX; i += 1) {
      expect(await statusOf(app, '/api/auth/signin', 'POST')).toBe(200);
    }
    expect(await statusOf(app, '/api/auth/signin', 'POST')).toBe(429);
  });

  it('are left to the edge when the deployment says the edge limits them', async () => {
    process.env.AUTH_RATE_LIMIT_AT_EDGE = 'true';
    const app = await copyWithLimits(freshRoute(), { max: 1 });

    for (let i = 0; i <= GLOBAL_MAX; i += 1) {
      expect(await statusOf(app, '/api/auth/signin', 'POST')).toBe(200);
    }
  });
});
