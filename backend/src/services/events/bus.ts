import { logger } from '../../logger';
import { type CarriedMessage, type Carrier, userOfMessage } from './carrier';
import type { ServerEvent } from './serverEvent';

/** A standing subscription to one user's messages. */
export interface Subscription {
  /**
   * Resolves once published messages reach this subscription. Never rejects.
   */
  ready: Promise<void>;
  close(): void;
}

/** The running Exchange a stop is for. */
export interface StopTarget {
  userId: string;
  threadId: string;
}

/** The news and stops of every user, delivered to whoever listens for them. */
export interface EventBus {
  /**
   * Hands the event to every subscriber of its user. Nothing is kept: a
   * subscriber that arrives later never sees it. A subscriber that throws
   * is logged and skipped; the rest still get the event.
   */
  publish(event: ServerEvent): void;
  /** Receives every event for the user until the subscription is closed. */
  subscribe(userId: string, handle: (event: ServerEvent) => void): Subscription;
  /** Asks the Thread's Exchange to stop. */
  requestStop(target: StopTarget): void;
  /** Runs `handle` when a stop is asked for the Thread's Exchange, until closed. */
  onStopRequested(target: StopTarget, handle: () => void): Subscription;
  /**
   * From now on, carries messages across process boundaries. `open`
   * receives the function that delivers incoming messages to subscribers.
   */
  carryAcross(open: (deliver: (message: CarriedMessage) => void) => Carrier): void;
}

type Listener = (message: CarriedMessage) => void;

interface UserListeners {
  listeners: Set<Listener>;
  /** Settles once published messages are being received. */
  ready: Promise<void>;
}

const READY = Promise.resolve();

/** An event bus implementation for local delivery with optional cross-process delivery. */
export function createEventBus(): EventBus {
  const users = new Map<string, UserListeners>();
  let carrier: Carrier | null = null;

  function deliver(message: CarriedMessage): void {
    const entry = users.get(userOfMessage(message));
    if (!entry) return;
    for (const listener of [...entry.listeners]) {
      try {
        listener(message);
      } catch (error) {
        logger.error({ err: error, kind: message.kind }, 'event subscriber failed');
      }
    }
  }

  function send(message: CarriedMessage): void {
    deliver(message);
    carrier?.send(message);
  }

  function listen(userId: string, listener: Listener): Subscription {
    let entry = users.get(userId);
    if (!entry) {
      entry = { listeners: new Set(), ready: carrier?.listen(userId) ?? READY };
      users.set(userId, entry);
    }
    const joined = entry;
    joined.listeners.add(listener);
    let closed = false;
    return {
      ready: joined.ready,
      close: () => {
        if (closed) return;
        closed = true;
        joined.listeners.delete(listener);
        if (joined.listeners.size > 0 || users.get(userId) !== joined) return;
        users.delete(userId);
        carrier?.unlisten(userId);
      },
    };
  }

  return {
    publish: (event) => send({ kind: 'event', event }),
    subscribe: (userId, handle) =>
      listen(userId, (message) => {
        if (message.kind === 'event') handle(message.event);
      }),
    requestStop: ({ userId, threadId }) => send({ kind: 'stop', userId, threadId }),
    onStopRequested: ({ userId, threadId }, handle) =>
      listen(userId, (message) => {
        if (message.kind === 'stop' && message.threadId === threadId) handle();
      }),
    carryAcross: (open) => {
      const opened = open(deliver);
      carrier = opened;
      for (const [userId, entry] of users) entry.ready = opened.listen(userId);
    },
  };
}

/** The local event bus instance. */
const bus = createEventBus();

export const publish: EventBus['publish'] = (event) => bus.publish(event);
export const subscribe: EventBus['subscribe'] = (userId, handle) => bus.subscribe(userId, handle);
export const requestStop: EventBus['requestStop'] = (target) => bus.requestStop(target);
export const onStopRequested: EventBus['onStopRequested'] = (target, handle) =>
  bus.onStopRequested(target, handle);
export const carryAcross: EventBus['carryAcross'] = (open) => bus.carryAcross(open);
