import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupModelsRefreshRoute } from './refresh';

/**
 * The session service is out of process. A request names its user in a
 * header, and a request without one is refused as an unsigned one would be.
 */
vi.mock('supertokens-node/recipe/session/framework/fastify', () => ({
  verifySession:
    () =>
    async (
      request: { headers: Record<string, unknown>; session?: unknown },
      reply: { code: (status: number) => { send: (body: unknown) => unknown } },
    ): Promise<void> => {
      const userId = request.headers['x-test-user'];
      if (userId === undefined) {
        reply.code(401).send({ message: 'unauthorised' });
        return;
      }
      request.session = { getUserId: () => String(userId) };
    },
}));

const refreshModelConfigs = vi.hoisted(() => vi.fn());
vi.mock('@services/modelConfigService', () => ({ refreshModelConfigs }));

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  setupModelsRefreshRoute(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  refreshModelConfigs.mockReset();
  refreshModelConfigs.mockResolvedValue({ success: true, modelsUpdated: 3 });
});

describe('POST /api/models/refresh', () => {
  it('refuses a caller without a session and refreshes nothing', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/models/refresh' });

    expect(response.statusCode).toBe(401);
    expect(refreshModelConfigs).not.toHaveBeenCalled();
  });

  it('refreshes for a signed-in user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/models/refresh',
      headers: { 'x-test-user': 'some-user' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, modelsUpdated: 3 });
    expect(refreshModelConfigs).toHaveBeenCalledTimes(1);
  });
});
