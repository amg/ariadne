import type { ServerEventKind, ServerEventOf } from './events';
import { sseTransport } from './transports/sse';

type AnyHandler = (event: never) => void;

/**
 * The tab's one push connection. Screens subscribe to the event kinds
 * they care about and filter by Thread themselves; the client hides the
 * carrier and its reconnections from them. Nothing here knows React:
 * the app shell owns the connection's lifetime.
 */

const subscriptions = new Map<ServerEventKind, Set<AnyHandler>>();
const reconnectedHandlers = new Set<() => void>();
let close: (() => void) | null = null;

/** Receives every event of one kind until the returned function is called. */
export function subscribe<Kind extends ServerEventKind>(
  kind: Kind,
  handler: (event: ServerEventOf<Kind>) => void,
): () => void {
  let handlers = subscriptions.get(kind);
  if (!handlers) {
    handlers = new Set();
    subscriptions.set(kind, handlers);
  }
  handlers.add(handler as AnyHandler);
  return () => {
    handlers?.delete(handler as AnyHandler);
  };
}

/**
 * Called each time the connection comes back after a drop, until the
 * returned function is called. Events sent during the gap are lost, so a
 * screen re-reads whatever it shows from push.
 */
export function onReconnected(handler: () => void) {
  reconnectedHandlers.add(handler);
  return () => {
    reconnectedHandlers.delete(handler);
  };
}

/**
 * Opens the connection once per tab; later calls are no-ops. Events
 * emitted while no screen is subscribed are simply dropped.
 */
export function connect() {
  if (close) return;
  close = sseTransport.open(
    (event) => {
      const handlers = subscriptions.get(event.kind);
      if (!handlers) return;
      for (const handler of [...handlers]) handler(event as never);
    },
    () => {
      for (const handler of [...reconnectedHandlers]) handler();
    },
  );
}

/** Closes the tab's connection; safe to call when none is open. */
export function disconnect() {
  close?.();
  close = null;
}
