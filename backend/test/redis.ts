import { Redis } from 'ioredis';

/**
 * The Redis the suites that cross backend copies run against. Every
 * worker shares it; tests keep apart by using fresh user ids and keys.
 */

/** Env var naming a Redis explicitly; always wins. */
const TEST_REDIS_URL_ENV = 'TEST_REDIS_URL';

/** Env var carrying the Redis the global setup found to the workers; unset when none. */
const FOUND_REDIS_URL_ENV = 'VITEST_TEST_REDIS_URL';

const REDIS_PORT = 6379;

/** Whether a Redis answers at `url` within a second. */
async function redisAnswers(url: string): Promise<boolean> {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 1_000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

/**
 * Finds the Redis to test against: the explicit URL, else one on the
 * default port of each host given, tried in order. Hands it to the
 * workers, or says the suites that need one will be skipped.
 */
export async function findTestRedis(hosts: string[]): Promise<void> {
  const explicit = process.env[TEST_REDIS_URL_ENV];
  const candidates = explicit ? [explicit] : hosts.map((host) => `redis://${host}:${REDIS_PORT}`);
  for (const url of candidates) {
    if (await redisAnswers(url)) {
      process.env[FOUND_REDIS_URL_ENV] = url;
      console.log(`[test-redis] ${url}`);
      return;
    }
  }
  delete process.env[FOUND_REDIS_URL_ENV];
  console.warn(
    `[test-redis] no Redis answered at ${candidates.join(', ')}: the suites that cross ` +
      `backend copies are skipped (start the compose redis, or set ${TEST_REDIS_URL_ENV})`,
  );
}

/** The Redis this run tests against, or null when none was found. */
export function testRedisUrlOrNull(): string | null {
  return process.env[FOUND_REDIS_URL_ENV] || null;
}
