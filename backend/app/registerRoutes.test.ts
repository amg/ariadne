import Fastify, { type FastifyInstance, type HTTPMethods } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerRoutes } from './registerRoutes';

/** The routes Memory owns: none of them exists in a deployment without it. */
const MEMORY_ROUTES: { method: HTTPMethods; url: string }[] = [
  { method: 'POST', url: '/api/threads/:id/capture-memory' },
  { method: 'GET', url: '/api/settings' },
  { method: 'PATCH', url: '/api/settings' },
  { method: 'GET', url: '/api/memory/facts' },
  { method: 'PATCH', url: '/api/memory/facts/:id' },
  { method: 'DELETE', url: '/api/memory/facts/:id' },
];

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function appWith(memory: boolean): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  registerRoutes(app, { memory });
  await app.ready();
  return app;
}

describe('registerRoutes', () => {
  it('serves no Memory route without Memory, and every one with it', async () => {
    const off = await appWith(false);
    for (const route of MEMORY_ROUTES) expect(off.hasRoute(route)).toBe(false);
    expect(off.hasRoute({ method: 'POST', url: '/api/threads/:id/handover' })).toBe(true);
    await off.close();

    const on = await appWith(true);
    for (const route of MEMORY_ROUTES) expect(on.hasRoute(route)).toBe(true);
  });

  it('tells the browser which features the deployment runs', async () => {
    for (const memory of [false, true]) {
      const served = await appWith(memory);
      const response = await served.inject({ method: 'GET', url: '/api/config' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        threadAnalysisMode: expect.any(String),
        features: { memory },
      });
      await served.close();
    }
  });
});
