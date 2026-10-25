import type { onResponseHookHandler } from 'fastify';
import { logAppRecord, roundedToTenthMs } from './records';

/**
 * A hook that logs a request as one record when its response ends, naming
 * the route that took it and never the address with its ids.
 */
export const logRequestEnded: onResponseHookHandler = (request, reply, done) => {
  logAppRecord({
    kind: 'request',
    endedAt: new Date().toISOString(),
    method: request.method,
    route: request.routeOptions.url ?? null,
    statusCode: reply.statusCode,
    durationMs: roundedToTenthMs(reply.elapsedTime),
  });
  done();
};
