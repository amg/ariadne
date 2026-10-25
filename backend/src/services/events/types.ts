import type { Redis } from 'ioredis';

/** The connections one backend copy holds to the shared Redis. */
export interface RedisConnection {
  /**
   * For commands that answer at once or fail: counting and publishing.
   * While Redis is unreachable they fail straight away instead of
   * waiting for it to come back.
   */
  commands: Redis;
  /**
   * Held in subscriber mode for the channels this copy listens to. What
   * it is asked while Redis is away is sent once it is back, and the
   * channels it already held are taken up again.
   */
  subscriber: Redis;
  close(): Promise<void>;
}
