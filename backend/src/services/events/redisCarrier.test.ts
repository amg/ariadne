import { randomUUID } from 'node:crypto';
import { testRedisUrlOrNull } from '@test/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RedisConnection, connectRedis } from '../../redis/connection';
import { type EventBus, createEventBus } from './bus';
import { redisCarrier } from './redisCarrier';
import type { ServerEvent } from './serverEvent';

const redisUrl = testRedisUrlOrNull();

/** One backend copy: its own bus on its own connections to the shared Redis. */
interface Copy {
  bus: EventBus;
  redis: RedisConnection;
}

async function startCopy(url: string): Promise<Copy> {
  const redis = await connectRedis(url);
  const bus = createEventBus();
  bus.carryAcross((deliver) => redisCarrier(redis, deliver));
  return { bus, redis };
}

function titled(userId: string): ServerEvent {
  return { kind: 'thread-titled', userId, threadId: randomUUID(), title: 'Tides' };
}

describe.skipIf(redisUrl === null)('the event bus across copies, over Redis', () => {
  let api: Copy;
  let worker: Copy;

  beforeAll(async () => {
    api = await startCopy(redisUrl ?? '');
    worker = await startCopy(redisUrl ?? '');
  });

  afterAll(async () => {
    await api.redis.close();
    await worker.redis.close();
  });

  it('delivers news published on one copy to a subscriber on another, once', async () => {
    const userId = randomUUID();
    const heardOnApi: ServerEvent[] = [];
    const heardOnWorker: ServerEvent[] = [];
    const tab = api.bus.subscribe(userId, (event) => heardOnApi.push(event));
    const local = worker.bus.subscribe(userId, (event) => heardOnWorker.push(event));
    await Promise.all([tab.ready, local.ready]);

    const news = titled(userId);
    worker.bus.publish(news);

    await expect.poll(() => heardOnApi).toEqual([news]);
    // The publishing copy delivered it itself, and never hears it back.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heardOnWorker).toEqual([news]);
    tab.close();
    local.close();
  });

  it('reaches only the copies listening to that user', async () => {
    const userId = randomUUID();
    const heard: ServerEvent[] = [];
    const tab = api.bus.subscribe(randomUUID(), (event) => heard.push(event));
    await tab.ready;

    worker.bus.publish(titled(userId));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heard).toEqual([]);
    tab.close();
  });

  it('carries a stop to the copy running the Exchange', async () => {
    const target = { userId: randomUUID(), threadId: randomUUID() };
    let stopped = 0;
    const running = worker.bus.onStopRequested(target, () => {
      stopped += 1;
    });
    await running.ready;

    api.bus.requestStop(target);

    await expect.poll(() => stopped).toBe(1);
    running.close();
  });

  it('stops delivering once the last subscriber on a copy leaves', async () => {
    const userId = randomUUID();
    const heard: ServerEvent[] = [];
    const tab = api.bus.subscribe(userId, (event) => heard.push(event));
    await tab.ready;
    tab.close();
    // A later subscription confirms the unsubscribe went through first.
    const probe = api.bus.subscribe(randomUUID(), () => {});
    await probe.ready;

    worker.bus.publish(titled(userId));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heard).toEqual([]);
    probe.close();
  });
});

describe('the event bus with Redis out of reach', () => {
  it('still delivering inside the copy, and carries on without waiting long', async () => {
    // Nothing listens on port 1: every connection attempt fails.
    const redis = await connectRedis('redis://127.0.0.1:1');
    try {
      const bus = createEventBus();
      bus.carryAcross((deliver) => redisCarrier(redis, deliver));
      const userId = randomUUID();
      const heard: ServerEvent[] = [];
      const subscription = bus.subscribe(userId, (event) => heard.push(event));

      const startedAt = Date.now();
      await subscription.ready;
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      const news = titled(userId);
      bus.publish(news);
      expect(heard).toEqual([news]);
      subscription.close();
    } finally {
      await redis.close();
    }
  });
});
