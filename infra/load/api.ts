import type { Plan } from './plan.ts';

/**
 * The few calls a user's browser makes, made the same way: through the
 * public hostname, so Cloudflare and the origin lock are part of every
 * measurement. On the direct path the same calls skip Cloudflare.
 * Sessions use header tokens rather than cookies, which the
 * backend accepts equally.
 */

export type Session = { headers: Record<string, string> };

export type ChatOutcome =
  | 'streamed'
  | 'paused'
  | 'still-checking'
  | 'conflict'
  | 'refused'
  | 'failed';

export type ChatResult = {
  outcome: ChatOutcome;
  /** Why the server refused, when it said so: `arrival_paused`, `exchange_in_flight` and the like. */
  errorCode: string | null;
  firstByteMs: number;
  totalMs: number;
  /** Seconds the server asked us to wait, when it asked. */
  retryAfterSeconds: number | null;
};

export class RequestFailed extends Error {
  readonly status: number;

  constructor(what: string, status: number) {
    super(`${what} answered ${status}`);
    this.status = status;
  }
}

export function signIn(plan: Plan, email: string): Promise<Session> {
  return authenticate(plan, '/api/auth/signin', email);
}

export function signUp(plan: Plan, email: string): Promise<Session> {
  return authenticate(plan, '/api/auth/signup', email);
}

async function authenticate(plan: Plan, path: string, email: string): Promise<Session> {
  const response = await fetch(`${plan.targetUrl}${path}`, {
    method: 'POST',
    headers: {
      ...edgeHeaders(plan),
      'content-type': 'application/json',
      rid: 'emailpassword',
      'st-auth-mode': 'header',
    },
    body: JSON.stringify({
      formFields: [
        { id: 'email', value: email },
        { id: 'password', value: plan.password },
      ],
    }),
  });
  const text = await response.text().catch(() => '');
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {}
  const status = typeof body.status === 'string' ? body.status : undefined;
  const token = response.headers.get('st-access-token');
  if (!response.ok || status !== 'OK' || token === null) {
    const detail = status ? JSON.stringify(body) : text.slice(0, 200) || 'no body';
    throw new RequestFailed(`${path} (${detail})`, response.status);
  }
  return { headers: { ...edgeHeaders(plan), authorization: `Bearer ${token}` } };
}

export async function createThread(plan: Plan, session: Session): Promise<string> {
  const response = await fetch(`${plan.targetUrl}/api/threads`, {
    method: 'POST',
    headers: { ...session.headers, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new RequestFailed('create thread', response.status);
  const thread = (await response.json()) as { id: string };
  return thread.id;
}

/** Sends one message and reads the reply stream to its end. */
export function sendChat(
  plan: Plan,
  session: Session,
  threadId: string,
  text: string,
): Promise<ChatResult> {
  return postChat(plan, session, threadId, {
    trigger: 'submit-message',
    messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
  });
}

/** Answers a paused message by keeping it in its Thread, as the UI's "continue" does. */
export function continuePaused(
  plan: Plan,
  session: Session,
  threadId: string,
): Promise<ChatResult> {
  return postChat(plan, session, threadId, { trigger: 'regenerate-message', choice: 'continue' });
}

async function postChat(
  plan: Plan,
  session: Session,
  threadId: string,
  body: object,
): Promise<ChatResult> {
  const startedAt = performance.now();
  const response = await fetch(`${plan.targetUrl}/api/threads/${threadId}/chat`, {
    method: 'POST',
    headers: { ...session.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  const firstByteMs = performance.now() - startedAt;
  if (response === null) {
    return {
      outcome: 'failed',
      errorCode: 'unreachable',
      firstByteMs,
      totalMs: firstByteMs,
      retryAfterSeconds: null,
    };
  }
  const text = await response.text().catch(() => '');
  return {
    outcome: response.status === 200 ? outcomeOfStream(text) : outcomeOf(response.status),
    errorCode: response.status === 200 ? null : errorCodeOf(text),
    firstByteMs,
    totalMs: performance.now() - startedAt,
    retryAfterSeconds: retryAfterOf(response),
  };
}

/**
 * A 200 is not always a reply. A message the Drift gate pauses gets its
 * verdict and no text, and waits for the user's choice; a reply that broke
 * mid-way ends on an error event.
 */
function outcomeOfStream(stream: string): ChatOutcome {
  if (stream.includes('"type":"error"')) return 'failed';
  if (stream.includes('"type":"text-delta"')) return 'streamed';
  if (stream.includes('"type":"data-thread-verdict"')) return 'paused';
  return 'failed';
}

function errorCodeOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const code = (parsed as { errorCode?: unknown }).errorCode;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

/**
 * Holds the user's push stream open until it ends or `signal` aborts,
 * calling `onEvent` for each event that arrives. Heartbeats are not events.
 */
export async function holdPush(
  plan: Plan,
  session: Session,
  signal: AbortSignal,
  onEvent: () => void,
): Promise<void> {
  const response = await fetch(`${plan.targetUrl}/api/events`, {
    headers: { ...session.headers, accept: 'text/event-stream' },
    signal,
  });
  if (!response.ok || response.body === null) throw new RequestFailed('push', response.status);
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    const text = decoder.decode(chunk, { stream: true });
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) onEvent();
    }
  }
}

function edgeHeaders(plan: Plan): Record<string, string> {
  return { [plan.loadKeyHeader]: plan.loadKey };
}

function outcomeOf(status: number): ChatOutcome {
  if (status === 503) return 'still-checking';
  if (status === 409) return 'conflict';
  if (status === 429) return 'refused';
  return 'failed';
}

function retryAfterOf(response: Response): number | null {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : null;
}
