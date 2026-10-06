import { logger } from '../../logger';
import type { ServerEvent } from './serverEvent';

type Subscriber = {
  wants: (event: ServerEvent) => boolean;
  handle: (event: ServerEvent) => void;
};

const subscribers = new Set<Subscriber>();

/**
 * Hands the event to every subscriber that wants it, at once. Nothing is
 * kept: a subscriber that arrives later never sees it. A subscriber that
 * throws is logged and skipped; the rest still get the event.
 */
export function publish(event: ServerEvent): void {
  for (const subscriber of [...subscribers]) {
    if (!subscriber.wants(event)) continue;
    try {
      subscriber.handle(event);
    } catch (error) {
      logger.error({ err: error, kind: event.kind }, 'event subscriber failed');
    }
  }
}

/** Receives every event the filter accepts until the returned function is called. */
export function subscribe(
  wants: (event: ServerEvent) => boolean,
  handle: (event: ServerEvent) => void,
): () => void {
  const subscriber: Subscriber = { wants, handle };
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}
