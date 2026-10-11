import type { ServerResponse } from 'node:http';
import { type ServerEvent, currentArrivalEvents, subscribe } from '@services/events';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRequest } from 'supertokens-node/framework/fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';

/**
 * A comment frame every 25 s keeps intermediaries from declaring the
 * stream idle and closing it; the stream itself carries nothing here.
 */
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * One SSE frame per event, named by its kind. The event's user is a
 * server-side filter and never rides the wire.
 */
function writeEvent(raw: ServerResponse, event: ServerEvent): void {
  const { userId, ...wire } = event;
  raw.write(`event: ${event.kind}\ndata: ${JSON.stringify(wire)}\n\n`);
}

/**
 * The push transport: one long-lived event stream per tab, authenticated
 * by the same session cookie as every other request. On connect it
 * re-emits the current state of the user's arrivals, then delivers live
 * news for that user, from whichever backend copy it comes, until the
 * connection closes.
 */
export async function setupEventsGetRoute(fastify: FastifyInstance) {
  fastify.get(
    '/api/events',
    { preHandler: verifySession() },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request as SessionRequest).session?.getUserId() as string;

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // The stream counts as open once its headers arrive, before any event.
      raw.flushHeaders();

      const subscription = subscribe(userId, (event) => writeEvent(raw, event));

      // Unref'd so a lingering stream never holds the process at shutdown.
      const heartbeat = setInterval(() => raw.write(': heartbeat\n\n'), HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();

      // Listening before the snapshot's await: a tab that leaves during it
      // must still release its subscription and heartbeat.
      raw.on('close', () => {
        clearInterval(heartbeat);
        subscription.close();
      });

      try {
        // The snapshot is read once news from other copies is sure to
        // arrive, so what lands meanwhile is either in it or delivered.
        await subscription.ready;
        for (const event of await currentArrivalEvents(userId)) writeEvent(raw, event);
      } catch (error) {
        request.log.error({ err: error }, 'could not re-emit arrival state on connect');
      }
    },
  );
}
