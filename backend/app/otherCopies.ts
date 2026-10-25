import { env } from '@config/env';
import { carryAcross, redisCarrier } from '@services/events';
import { logger } from '../src/logger';
import { connectRedis } from '../src/redis/connection';

/**
 * Joins the other backend copies through the configured Redis: news and
 * stops cross between copies from here on. Null when no Redis is
 * configured, and this process works on its own.
 */
export async function joinOtherCopiesOrNull() {
  const url = env.VALKEY_URL;
  if (url === undefined) return null;
  const redis = await connectRedis(url);
  carryAcross((deliver) => redisCarrier(redis, deliver));
  logger.info('news and stops are shared with the other copies');
  return redis;
}

/**
 * Refuses to run apart from the rest of the backend without a Redis: the
 * worker's news would never reach the API, and every chat would wait out
 * its full gate wait.
 */
export function requireRedisWhenSplit() {
  if (env.PROCESS_ROLE === 'all' || env.VALKEY_URL !== undefined) return;
  throw new Error(
    `PROCESS_ROLE=${env.PROCESS_ROLE} runs apart from the rest of the backend and needs VALKEY_URL`,
  );
}
