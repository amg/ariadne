import { randomUUID } from 'node:crypto';
import { logger } from '../../logger';
import type { RedisConnection } from '../../redis/connection';
import { type CarriedMessage, type Carrier, userOfMessage } from './carrier';

/**
 * How long a copy waits to hear that its subscription to a user holds.
 * Past it the caller carries on, and relies on reading the database.
 */
const LISTEN_WAIT_MS = 1_000;

/** What travels on a channel: the message, and which copy sent it. */
interface Envelope {
  origin: string;
  message: CarriedMessage;
}

/** One channel per user, so a message reaches only the copies holding that user. */
function channelOf(userId: string): string {
  return `ari:user:${userId}`;
}

function envelopeOrNull(payload: string): Envelope | null {
  try {
    // Every publisher is a copy of this backend writing the same shape;
    // trusted like a queued job's payload.
    return JSON.parse(payload) as Envelope;
  } catch {
    return null;
  }
}

/** Resolves once the work settles or the wait is over, whichever comes first. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work.then(
      () => {},
      () => {},
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Carries messages between backend copies over Redis's sharded pub/sub,
 * on one channel per user. A copy never hears its own messages back:
 * the bus has already delivered them inside the copy.
 */
export function redisCarrier(
  redis: RedisConnection,
  deliver: (message: CarriedMessage) => void,
): Carrier {
  const origin = randomUUID();

  redis.subscriber.on('smessage', (_channel: string, payload: string) => {
    const envelope = envelopeOrNull(payload);
    if (envelope === null || envelope.origin === origin) return;
    deliver(envelope.message);
  });

  return {
    send(message) {
      const envelope: Envelope = { origin, message };
      redis.commands
        .spublish(channelOf(userOfMessage(message)), JSON.stringify(envelope))
        .catch((error: unknown) => {
          logger.debug(
            { err: error, kind: message.kind },
            'could not carry a message to other copies',
          );
        });
    },

    async listen(userId) {
      const subscribed = redis.subscriber.ssubscribe(channelOf(userId));
      subscribed.catch((error: unknown) => {
        logger.warn({ err: error }, 'could not listen to a user across copies');
      });
      await settledWithin(subscribed, LISTEN_WAIT_MS);
    },

    unlisten(userId) {
      redis.subscriber.sunsubscribe(channelOf(userId)).catch((error: unknown) => {
        logger.debug({ err: error }, 'could not stop listening to a user across copies');
      });
    },
  };
}
