import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logger } from '../../logger';
import { type CarriedMessage, type Carrier, carriedMessageSchema, userOfMessage } from './carrier';
import { countCarrierFailure } from './carrierFailures';
import type { RedisConnection } from './types';

/**
 * How long a copy waits to hear that its subscription to a user holds.
 * Past it the caller carries on, and relies on reading the database.
 */
const LISTEN_WAIT_MS = 1_000;

/** What travels on a channel: the message, and which copy sent it. */
const envelopeSchema = z.object({ origin: z.string(), message: carriedMessageSchema });

/** One channel per user, so a message reaches only the copies holding that user. */
function channelOf(userId: string) {
  return `ari:user:${userId}`;
}

/** The envelope a payload holds, or null for anything else, such as a shape from another version. */
function envelopeOrNull(payload: string) {
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Resolves once the work settles or the wait is over, whichever comes first. */
async function settledWithin(work: Promise<unknown>, ms: number) {
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
    if (envelope === null) {
      logger.warn('dropped a message from another copy that is not an envelope');
      return;
    }
    if (envelope.origin === origin) return;
    deliver(envelope.message);
  });

  return {
    send(message) {
      // Async, so a message that cannot be addressed or written fails like a failed publish.
      (async () => {
        const envelope = { origin, message };
        await redis.commands.spublish(channelOf(userOfMessage(message)), JSON.stringify(envelope));
      })().catch((error: unknown) => {
        countCarrierFailure();
        logger.debug(
          { err: error, kind: message.kind },
          'could not carry a message to other copies',
        );
      });
    },

    async listen(userId) {
      const subscribed = redis.subscriber.ssubscribe(channelOf(userId));
      subscribed.catch((error: unknown) => {
        countCarrierFailure();
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
