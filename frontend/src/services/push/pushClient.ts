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
 * Opens the connection once per tab; later calls are no-ops. Events
 * emitted while no screen is subscribed are simply dropped.
 */
export function connect(): void {
  if (close) return;
  close = sseTransport.open((event) => {
    const handlers = subscriptions.get(event.kind);
    if (!handlers) return;
    for (const handler of [...handlers]) handler(event as never);
  });
}

/** Closes the tab's connection; safe to call when none is open. */
export function disconnect(): void {
  close?.();
  close = null;
}
