import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '../../types/events';
import { createEventBus } from './bus';
import type { CarriedMessage, Carrier } from './carrier';

function titled(userId: string, title = 'Tides'): ServerEvent {
  return { kind: 'thread-titled', userId, threadId: randomUUID(), title };
}

/** A carrier that only records what the bus asks of it. */
function recordingCarrier() {
  const calls: string[] = [];
  const sent: CarriedMessage[] = [];
  const carrier: Carrier = {
    send: (message) => {
      sent.push(message);
    },
    listen: async (userId) => {
      calls.push(`listen ${userId}`);
    },
    unlisten: (userId) => {
      calls.push(`unlisten ${userId}`);
    },
  };
  return { carrier, calls, sent };
}

describe('the event bus inside one process', () => {
  it('delivers a user\u2019s news to that user\u2019s subscribers only, at once', () => {
    const bus = createEventBus();
    const alice = randomUUID();
    const heardByAlice: ServerEvent[] = [];
    const heardByBob: ServerEvent[] = [];
    bus.subscribe(alice, (event) => heardByAlice.push(event));
    bus.subscribe(randomUUID(), (event) => heardByBob.push(event));

    const news = titled(alice);
    bus.publish(news);

    expect(heardByAlice).toEqual([news]);
    expect(heardByBob).toEqual([]);
  });

  it('is ready at once', async () => {
    const bus = createEventBus();
    await expect(bus.subscribe(randomUUID(), () => {}).ready).resolves.toBeUndefined();
  });

  it('keeps delivering past a subscriber that throws', () => {
    const bus = createEventBus();
    const userId = randomUUID();
    const heard: ServerEvent[] = [];
    bus.subscribe(userId, () => {
      throw new Error('broken tab');
    });
    bus.subscribe(userId, (event) => heard.push(event));

    bus.publish(titled(userId));

    expect(heard).toHaveLength(1);
  });

  it('hands a stop to the listener of that Thread\u2019s Exchange, never to news subscribers', () => {
    const bus = createEventBus();
    const userId = randomUUID();
    const threadId = randomUUID();
    const news: ServerEvent[] = [];
    let stopped = 0;
    let otherStopped = 0;
    bus.subscribe(userId, (event) => news.push(event));
    bus.onStopRequested({ userId, threadId }, () => {
      stopped += 1;
    });
    bus.onStopRequested({ userId, threadId: randomUUID() }, () => {
      otherStopped += 1;
    });

    bus.requestStop({ userId, threadId });

    expect(stopped).toBe(1);
    expect(otherStopped).toBe(0);
    expect(news).toEqual([]);
  });

  it('delivers nothing to a closed subscription', () => {
    const bus = createEventBus();
    const userId = randomUUID();
    const heard: ServerEvent[] = [];
    const subscription = bus.subscribe(userId, (event) => heard.push(event));
    subscription.close();

    bus.publish(titled(userId));

    expect(heard).toEqual([]);
  });
});

describe('the event bus carried across copies', () => {
  it('listens to a user once while anyone here subscribes, and stops when the last one leaves', () => {
    const bus = createEventBus();
    const { carrier, calls } = recordingCarrier();
    bus.carryAcross(() => carrier);
    const userId = randomUUID();

    const tab = bus.subscribe(userId, () => {});
    const waitingChat = bus.subscribe(userId, () => {});
    tab.close();
    tab.close();
    waitingChat.close();
    bus.subscribe(userId, () => {});

    expect(calls).toEqual([`listen ${userId}`, `unlisten ${userId}`, `listen ${userId}`]);
  });

  it('sends what it publishes to the other copies, and still delivers it here', () => {
    const bus = createEventBus();
    const { carrier, sent } = recordingCarrier();
    bus.carryAcross(() => carrier);
    const userId = randomUUID();
    const heard: ServerEvent[] = [];
    bus.subscribe(userId, (event) => heard.push(event));

    const news = titled(userId);
    bus.publish(news);
    bus.requestStop({ userId, threadId: news.threadId });

    expect(heard).toEqual([news]);
    expect(sent).toEqual([
      { kind: 'event', event: news },
      { kind: 'stop', userId, threadId: news.threadId },
    ]);
  });

  it('hands what another copy sends to the subscribers here', () => {
    const bus = createEventBus();
    let deliver: (message: CarriedMessage) => void = () => {};
    bus.carryAcross((handTo) => {
      deliver = handTo;
      return recordingCarrier().carrier;
    });
    const userId = randomUUID();
    const heard: ServerEvent[] = [];
    bus.subscribe(userId, (event) => heard.push(event));

    const news = titled(userId);
    deliver({ kind: 'event', event: news });

    expect(heard).toEqual([news]);
  });

  it('starts listening to the users already subscribed when it is carried across', () => {
    const bus = createEventBus();
    const userId = randomUUID();
    bus.subscribe(userId, () => {});
    const { carrier, calls } = recordingCarrier();

    bus.carryAcross(() => carrier);

    expect(calls).toEqual([`listen ${userId}`]);
  });
});
