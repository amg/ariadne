import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rateLimitKey } from './rateLimitKey';

/** The session service is out of process; a token is valid when it reads `valid:<userId>`. */
vi.mock('supertokens-node/recipe/session', () => ({
  default: {
    getSessionWithoutRequestResponse: async (token: string) => {
      const userId = token.match(/^valid:(.+)$/)?.[1];
      if (userId === undefined) throw new Error('invalid token');
      return { getUserId: () => userId };
    },
  },
}));

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

/** An app allowing one request per bucket per minute. */
async function appAllowingOneRequest() {
  app = Fastify({ logger: false });
  await app.register(rateLimit, {
    global: true,
    max: 1,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
  });
  app.get('/ping', async () => 'pong');
  await app.ready();
  return app;
}

function asCookie(token: string) {
  return { cookie: `theme=dark; sAccessToken=${encodeURIComponent(token)}` };
}

describe('rateLimitKey', () => {
  it('gives each signed-in user their own bucket', async () => {
    const server = await appAllowingOneRequest();
    const ping = (headers: Record<string, string>) => server.inject({ url: '/ping', headers });

    expect((await ping(asCookie('valid:alice'))).statusCode).toBe(200);
    expect((await ping(asCookie('valid:alice'))).statusCode).toBe(429);
    expect((await ping({ authorization: 'Bearer valid:bob' })).statusCode).toBe(200);
    expect((await ping({})).statusCode).toBe(200);
  });

  it('counts requests without a valid session against the client address', async () => {
    const server = await appAllowingOneRequest();
    const ping = (headers: Record<string, string>) => server.inject({ url: '/ping', headers });

    expect((await ping(asCookie('forged'))).statusCode).toBe(200);
    expect((await ping({})).statusCode).toBe(429);
  });
});
