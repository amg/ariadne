import type { ServerEvent } from './events';

/**
 * One connection that delivers server events. Push transports (SSE today,
 * a WebSocket later) all satisfy this shape, so swapping the carrier
 * touches only the transport and the browser's matching client.
 */
export interface PushTransport {
  /**
   * Opens the connection and hands every received event to `onEvent`.
   * Returns a disposer that closes the connection; the transport
   * reconnects on its own until then, or until the session has ended.
   * `onReconnected` fires each time the connection comes back after a
   * drop: events sent during the gap are lost, not replayed.
   */
  open(onEvent: (event: ServerEvent) => void, onReconnected: () => void): () => void;
}
