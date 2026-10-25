import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { CarriedMessage } from './carrier';
import { redisCarrier } from './redisCarrier';
import type { RedisConnection } from './types';

/**
 * A connection that only does what the carrier asks of it here: hand over
 * what arrives on a channel, and keep what is published. No Redis needed.
 */
function fakeConnection() {
  const published: string[] = [];
  const subscriber = new EventEmitter();
  const connection = {
    commands: {
      spublish: async (_channel: string, payload: string) => {
        published.push(payload);
        return 1;
      },
    },
    subscriber,
  } as unknown as RedisConnection; // Cast: only the calls the carrier makes are faked.
  return {
    connection,
    published,
    hear: (payload: string) => subscriber.emit('smessage', 'channel', payload),
  };
}

const stop: CarriedMessage = { kind: 'stop', userId: 'user-1', threadId: 'thread-1' };
const titled: CarriedMessage = {
  kind: 'event',
  event: { kind: 'thread-titled', userId: 'user-1', threadId: 'thread-1', title: 'Tides' },
};

describe('redisCarrier reading what another copy published', () => {
  it('delivers a well-formed envelope from another copy', () => {
    const { connection, hear } = fakeConnection();
    const deliver = vi.fn();
    redisCarrier(connection, deliver);

    hear(JSON.stringify({ origin: 'other-copy', message: titled }));
    hear(JSON.stringify({ origin: 'other-copy', message: stop }));

    expect(deliver.mock.calls).toEqual([[titled], [stop]]);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['JSON that is not an object', 'null'],
    ['an object without a message', JSON.stringify({ origin: 'other-copy' })],
    [
      'a message of a kind this copy does not know',
      JSON.stringify({
        origin: 'other-copy',
        message: { kind: 'from-the-future', userId: 'user-1' },
      }),
    ],
    [
      'an event without its user',
      JSON.stringify({
        origin: 'other-copy',
        message: { kind: 'event', event: { kind: 'thread-titled', threadId: 't', title: 'x' } },
      }),
    ],
    [
      'a stop without its Thread',
      JSON.stringify({ origin: 'other-copy', message: { kind: 'stop', userId: 'user-1' } }),
    ],
    ['an origin that is not text', JSON.stringify({ origin: 7, message: titled })],
    [
      'a verdict that is not one the gate gives',
      JSON.stringify({
        origin: 'other-copy',
        message: {
          kind: 'event',
          event: {
            kind: 'verdict-ok',
            userId: 'u',
            threadId: 't',
            messageId: 'm',
            verdict: 'maybe',
          },
        },
      }),
    ],
  ])('drops %s without throwing', (_what, payload) => {
    const { connection, hear } = fakeConnection();
    const deliver = vi.fn();
    redisCarrier(connection, deliver);

    expect(() => hear(payload)).not.toThrow();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not throw when a message to send cannot be addressed', async () => {
    const { connection, published } = fakeConnection();
    const carrier = redisCarrier(connection, vi.fn());
    // Cast: a message that breaks the type, as a copy of another version could send.
    const unaddressable = { kind: 'event' } as unknown as CarriedMessage;

    expect(() => carrier.send(unaddressable)).not.toThrow();
    await Promise.resolve();
    expect(published).toEqual([]);
  });

  it('never hears its own message back', () => {
    const { connection, published, hear } = fakeConnection();
    const deliver = vi.fn();
    const carrier = redisCarrier(connection, deliver);

    carrier.send(titled);
    expect(published).toHaveLength(1);
    hear(published[0] ?? '');

    expect(deliver).not.toHaveBeenCalled();
  });
});
