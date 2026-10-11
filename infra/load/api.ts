import type { Plan } from './plan.ts';

/**
 * The few calls a user's browser makes, made the same way: through the
 * public hostname, so Cloudflare and the origin lock are part of every
 * measurement. Sessions use header tokens rather than cookies, which the
 * backend accepts equally.
 */

export type Session = { headers: Record<string, string> };

export type ChatOutcome = 'streamed' | 'still-checking' | 'conflict' | 'refused' | 'failed';

export type ChatResult = {
  outcome: ChatOutcome;
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
  const body = (await response.json().catch(() => ({}))) as { status?: string };
  const token = response.headers.get('st-access-token');
  if (!response.ok || body.status !== 'OK' || token === null) {
    throw new RequestFailed(`${path} (${body.status ?? 'no status'})`, response.status);
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
export async function sendChat(
  plan: Plan,
  session: Session,
  threadId: string,
  text: string,
): Promise<ChatResult> {
  const startedAt = performance.now();
  const response = await fetch(`${plan.targetUrl}/api/threads/${threadId}/chat`, {
    method: 'POST',
    headers: { ...session.headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      trigger: 'submit-message',
      messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
    }),
  });
  const firstByteMs = performance.now() - startedAt;
  await drain(response.body);
  return {
    outcome: outcomeOf(response.status),
    firstByteMs,
    totalMs: performance.now() - startedAt,
    retryAfterSeconds: retryAfterOf(response),
  };
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
  if (status === 200) return 'streamed';
  if (status === 503) return 'still-checking';
  if (status === 409) return 'conflict';
  if (status === 429) return 'refused';
  return 'failed';
}

function retryAfterOf(response: Response): number | null {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function drain(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  for await (const _chunk of body) {
    // Reading is the point: the reply is only complete once its stream ends.
  }
}
