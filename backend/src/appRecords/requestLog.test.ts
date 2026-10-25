import { useAppRecordCapture } from '@test/appRecords';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { copyName } from './copyName';
import { logRequestEnded } from './requestLog';

const capture = useAppRecordCapture();

async function appWithRoutes() {
  const app = Fastify();
  app.addHook('onResponse', logRequestEnded);
  app.get('/api/threads/:threadId', async () => ({ ok: true }));
  app.post('/api/fail', async (_request, reply) => reply.code(503).send({ error: 'down' }));
  await app.ready();
  return app;
}

describe('the request record', () => {
  it('names the route’s pattern, and not the address with its ids', async () => {
    const app = await appWithRoutes();
    const before = Date.now();

    await app.inject({ method: 'GET', url: '/api/threads/0b1c2d3e?draft=1' });

    const [record, ...others] = capture.written('request');
    expect(others).toEqual([]);
    expect(record).toMatchObject({
      copy: copyName(),
      method: 'GET',
      route: '/api/threads/:threadId',
      statusCode: 200,
    });
    expect(JSON.stringify(record)).not.toContain('0b1c2d3e');
    expect(Date.parse(record?.endedAt ?? '')).toBeGreaterThanOrEqual(before - 5);
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('carries the status of a response that failed', async () => {
    const app = await appWithRoutes();

    await app.inject({ method: 'POST', url: '/api/fail' });

    expect(capture.written('request')).toMatchObject([{ method: 'POST', statusCode: 503 }]);
  });

  it('has no route for a request that no route took', async () => {
    const app = await appWithRoutes();

    await app.inject({ method: 'GET', url: '/nowhere' });

    expect(capture.written('request')).toMatchObject([{ route: null, statusCode: 404 }]);
  });
});
