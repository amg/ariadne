import { Redis } from 'ioredis';
import { logger } from '../logger';

/**
 * How long a command may take before it counts as failed. Counting and
 * publishing sit on the request path, so a slow Redis must not slow
 * every request down with it.
 */
const COMMAND_TIMEOUT_MS = 250;

/** The longest startup waits for Redis before carrying on without it. */
const STARTUP_WAIT_MS = 5_000;

/** Logs a connection going down once, and coming back once, instead of every retry. */
function reportHealth(client: Redis, name: string) {
  let healthy = true;
  client.on('ready', () => {
    if (!healthy) logger.info({ redis: name }, 'redis connection restored');
    healthy = true;
  });
  client.on('error', (error: Error) => {
    if (!healthy) return;
    healthy = false;
    logger.warn({ err: error, redis: name }, 'redis connection failed; retrying');
  });
}

/** Resolves once the client is connected, has failed to connect, or the wait is over. */
async function readyOrGivenUp(client: Redis) {
  if (client.status === 'ready') return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, STARTUP_WAIT_MS);
    client.once('ready', done);
    client.once('error', done);
    function done() {
      clearTimeout(timer);
      client.off('ready', done);
      client.off('error', done);
      resolve();
    }
  });
}

/**
 * Connects to Redis at `url` (`redis://`, or `rediss://` for TLS).
 * Waits briefly for the connection, then returns either way: a backend
 * copy starts without Redis and uses it once it is reachable.
 */
export async function connectRedis(url: string) {
  const commands = new Redis(url, {
    commandTimeout: COMMAND_TIMEOUT_MS,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  });
  const subscriber = new Redis(url);
  reportHealth(commands, 'commands');
  reportHealth(subscriber, 'subscriber');

  await Promise.all([readyOrGivenUp(commands), readyOrGivenUp(subscriber)]);
  if (commands.status !== 'ready' || subscriber.status !== 'ready') {
    logger.warn('redis is not reachable yet; this copy works on its own until it is');
  }

  return {
    commands,
    subscriber,
    close: async () => {
      commands.disconnect();
      subscriber.disconnect();
    },
  };
}
