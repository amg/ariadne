import Session from 'supertokens-auth-react/recipe/session';
import { SERVER_EVENT_KINDS, type ServerEvent, type ServerEventKind } from '../events';
import type { PushTransport } from '../transport';

function stringOrNull(value: unknown, allowed: readonly string[]): string | null {
  return allowed.includes(value as string) ? (value as string) : null;
}

function messageIdOrNull(body: Record<string, unknown>): string | null {
  return typeof body.messageId === 'string' ? body.messageId : null;
}

/**
 * Parses one frame's JSON payload into the event its kind names; null on
 * anything malformed, which a dodgy intermediate could hand us. Each
 * branch spells out the fields the server promises for that kind.
 */
function parsePayload(kind: ServerEventKind, data: unknown): ServerEvent | null {
  if (typeof data !== 'object' || data === null) return null;
  const body = data as Record<string, unknown>;
  if (typeof body.threadId !== 'string') return null;
  const threadId = body.threadId;

  if (kind === 'thread-titled') {
    return typeof body.title === 'string' ? { kind, threadId, title: body.title } : null;
  }
  if (kind === 'memory-captured' || kind === 'memory-capture-failed') {
    return typeof body.segmentId === 'string'
      ? { kind, threadId, segmentId: body.segmentId }
      : null;
  }

  const messageId = messageIdOrNull(body);
  if (!messageId) return null;
  if (kind === 'verdict-ok') {
    const verdict = stringOrNull(body.verdict, ['pass', 'muted', 'fire']);
    return { kind, threadId, messageId, verdict: verdict as 'pass' | 'muted' | 'fire' | null };
  }
  if (kind === 'verdict-paused') {
    const fireChannel = stringOrNull(body.fireChannel, ['immediate', 'slow']);
    return {
      kind,
      threadId,
      messageId,
      fireChannel: fireChannel as 'immediate' | 'slow' | null,
    };
  }
  // The one remaining kind: gate-failed carries only its scope.
  return { kind, threadId, messageId };
}

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

/** Hands each named event on the stream to `onEvent`, parsed. */
function listen(source: EventSource, onEvent: (event: ServerEvent) => void): void {
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
      const event = parsePayload(kind, data);
      if (event) onEvent(event);
    });
  }
}

/**
 * Whether the stream may be reopened: true once the session is refreshed,
 * and also when the refresh itself could not reach the backend, which a
 * later attempt can fix. False when the session has really ended.
 */
async function sessionStillUsable(): Promise<boolean> {
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

    const reopenLater = () => {
      retryTimer = setTimeout(async () => {
        retryTimer = null;
        if (disposed) return;
        if (!(await sessionStillUsable())) return;
        if (!disposed) dial();
      }, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    };

    const dial = () => {
      const current = new EventSource('/api/events', { withCredentials: true });
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
