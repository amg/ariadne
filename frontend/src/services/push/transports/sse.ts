import { pathOf } from '@ari/lib/api/schemas/common/endpoint';
import { events, serverEventSchema } from '@ari/lib/api/schemas/events/events';
import Session from 'supertokens-auth-react/recipe/session';
import { SERVER_EVENT_KINDS, type ServerEvent, type ServerEventKind } from '../events';
import type { PushTransport } from '../transport';

/**
 * Reads one frame's JSON payload as the event its kind names; null on
 * anything malformed, which a dodgy intermediate could hand us.
 */
function eventOrNull(kind: ServerEventKind, data: unknown) {
  if (typeof data !== 'object' || data === null) return null;
  const parsed = serverEventSchema.safeParse({ ...data, kind });
  return parsed.success ? parsed.data : null;
}

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/** Hands each named event on the stream to `onEvent`, parsed. */
function listen(source: EventSource, onEvent: (event: ServerEvent) => void) {
  for (const kind of SERVER_EVENT_KINDS) {
    // Named events arrive as MessageEvents; anything else on this
    // stream is a heartbeat comment the browser already ignores.
    source.addEventListener(kind, (received: Event) => {
      if (!(received instanceof MessageEvent)) return;
      let data: unknown;
      try {
        data = JSON.parse(received.data as string);
      } catch {
        return;
      }
      const event = eventOrNull(kind, data);
      if (event) onEvent(event);
    });
  }
}

/**
 * Whether the stream may be reopened: true once the session is refreshed,
 * and also when the refresh itself could not reach the backend, which a
 * later attempt can fix. False when the session has really ended.
 */
async function sessionStillUsable() {
  try {
    return await Session.attemptRefreshingSession();
  } catch {
    return true;
  }
}

/**
 * The SSE carrier: one EventSource to the push endpoint, authenticated by
 * the session cookie; each event kind is a named stream on it. The browser
 * redials a broken connection by itself, but gives up for good when a
 * redial is refused (an expired access token, a backend mid-deploy). Then
 * the carrier refreshes the session and reopens with backoff, stopping
 * only once the session has ended.
 */
export const sseTransport: PushTransport = {
  open(onEvent, onReconnected) {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = FIRST_RETRY_MS;
    let everOpened = false;
    let disposed = false;

    // Each wait falls somewhere in the upper half of the current backoff,
    // so tabs refused together do not come back together.
    const reopenLater = () => {
      retryTimer = setTimeout(
        async () => {
          retryTimer = null;
          if (disposed) return;
          if (!(await sessionStillUsable())) return;
          if (!disposed) dial();
        },
        retryMs * (0.5 + Math.random() / 2),
      );
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    };

    const dial = () => {
      const current = new EventSource(pathOf(events), { withCredentials: true });
      source = current;
      listen(current, onEvent);
      current.onopen = () => {
        retryMs = FIRST_RETRY_MS;
        if (everOpened) onReconnected();
        everOpened = true;
      };
      current.onerror = () => {
        // While CONNECTING the browser is redialing on its own.
        if (current.readyState !== EventSource.CLOSED || disposed) return;
        reopenLater();
      };
    };

    dial();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  },
};
