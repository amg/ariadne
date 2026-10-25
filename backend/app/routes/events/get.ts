import type { ServerResponse } from 'node:http';
import type { Writable } from 'node:stream';
import type { Served } from '@ari/lib/api/schemas/common/wire';
import {
  events,
  PUSH_RECONNECT_SPREAD_MS,
  type serverEventSchema,
} from '@ari/lib/api/schemas/events/events';
import { currentArrivalEvents, subscribe } from '@services/events';
import type { FastifyInstance } from 'fastify';
import { verifySession } from 'supertokens-node/recipe/session/framework/fastify';
import type { ServerEvent } from '../../../src/types/events';
import { countPushStream } from '../../pushStreams';
import type { RouteOf } from '../contract';
import { userIdOf } from '../request';

/**
 * A comment frame every 25 s keeps intermediaries from declaring the
 * stream idle and closing it; the stream itself carries nothing here.
 */
const HEARTBEAT_INTERVAL_MS = 25_000;

/** What a heartbeat needs of a stream: to write to it, to see whether it took the last write, and to end it. */
type HeartbeatTarget = Pick<Writable, 'write' | 'destroy' | 'writableNeedDrain' | 'destroyed'>;

/**
 * Sends one heartbeat, or ends a stream whose earlier writes are still
 * backed up: more waits to be sent than the stream buffers. A tab that
 * reads its stream never backs it up between heartbeats, so a backed-up
 * stream has no one reading it. Ending it closes the stream, which stops
 * it being counted as open. A connection whose far end vanished does not
 * back up this way; it closes when the network gives up on it.
 */
export function beatOrEnd(stream: HeartbeatTarget) {
  if (stream.destroyed) return;
  if (stream.writableNeedDrain) {
    stream.destroy();
    return;
  }
  stream.write(': heartbeat\n\n');
}

/**
 * Tells the browser how long to wait before it redials this stream once it
 * breaks. Each stream draws its own wait from the reconnect spread, so tabs
 * whose streams break together come back spread out.
 */
function reconnectWaitFrame() {
  return `retry: ${Math.floor(Math.random() * PUSH_RECONNECT_SPREAD_MS)}\n\n`;
}

/**
 * One SSE frame per event, named by its kind. The event's user is a
 * server-side filter and never rides the wire.
 */
function writeEvent(raw: ServerResponse, event: ServerEvent) {
  const { userId, ...rest } = event;
  const wire: Served<typeof serverEventSchema> = rest;
  raw.write(`event: ${event.kind}\ndata: ${JSON.stringify(wire)}\n\n`);
}

/**
 * The push transport: one long-lived event stream per tab, authenticated
 * by the same session cookie as every other request. On connect it
 * re-emits the current state of the user's arrivals, then delivers live
 * news for that user, from whichever backend copy it comes, until the
 * connection closes.
 */
export function setupEventsGetRoute(fastify: FastifyInstance) {
  fastify.route<RouteOf<typeof events>>({
    method: events.method,
    url: events.path,
    preHandler: verifySession(),
    handler: async (request, reply) => {
      const userId = userIdOf(request);

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
      const streamClosed = countPushStream();
      raw.write(reconnectWaitFrame());

      const subscription = subscribe(userId, (event) => writeEvent(raw, event));

      // Unref'd so a lingering stream never holds the process at shutdown.
      // A tab that vanished without closing its connection is noticed when
      // the network gives up delivering a heartbeat, which closes the stream.
      const heartbeat = setInterval(() => beatOrEnd(raw), HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();

      // Listening before the snapshot's await: a tab that leaves during it
      // must still release its subscription and heartbeat.
      raw.on('close', () => {
        streamClosed();
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
  });
}
