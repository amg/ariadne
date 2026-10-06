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

/**
 * The SSE carrier: one EventSource to the push endpoint, authenticated by
 * the session cookie. EventSource redials on every broken connection with
 * no help from the caller; each event kind is a named stream on it.
 */
export const sseTransport: PushTransport = {
  open(onEvent) {
    const source = new EventSource('/api/events', { withCredentials: true });
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
    return () => source.close();
  },
};
