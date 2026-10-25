import { describe, expect, it } from 'vitest';
import { countCarrierFailure, takeCarrierFailures } from './carrierFailures';
import { redisCarrier } from './redisCarrier';
import type { RedisConnection } from './types';

/** A connection whose commands and subscriptions all fail, as a Redis that has gone away. */
function brokenRedis() {
  const fail = () => Promise.reject(new Error('connection lost'));
  // The cast is needed because the real connection holds two full Redis clients, and the carrier uses only the calls given here.
  return {
    commands: { spublish: fail },
    subscriber: { on: () => undefined, ssubscribe: fail, sunsubscribe: fail },
    close: async () => undefined,
  } as unknown as RedisConnection;
}

describe('the failures counted for the carrier', () => {
  it('are given once, then counted again from nothing', () => {
    takeCarrierFailures();
    countCarrierFailure();
    countCarrierFailure();

    expect(takeCarrierFailures()).toBe(2);
    expect(takeCarrierFailures()).toBe(0);
  });

  it('include a message that could not be sent and a user that could not be listened to', async () => {
    takeCarrierFailures();
    const carrier = redisCarrier(brokenRedis(), () => undefined);

    carrier.send({ kind: 'stop', userId: 'u1', threadId: 't1' });
    await carrier.listen('u1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(takeCarrierFailures()).toBe(2);
  });
});
