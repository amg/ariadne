import {
  type ChatRequest,
  GATE_WAIT_CODES,
  VERDICT_PART_TYPE,
  chat,
} from '@ari/lib/api/schemas/chat/chat';
import { pathOf } from '@ari/lib/api/schemas/common/endpoint';
import { events } from '@ari/lib/api/schemas/events/events';
import {
  createThread as createThreadEndpoint,
  threadSchema,
} from '@ari/lib/api/schemas/threads/thread';
import type { RequestOutcome } from '../records/index.ts';
import type { Plan } from './plan.ts';
import { createEventReader } from './pushEvents.ts';
import { RequestFailed } from './requestFailed.ts';
import { type UserRequests, cutShort, startStopwatch, unanswered } from './requestLog.ts';
import { bodyOrNull } from './responseBody.ts';
import { type Session, type Tokens, createSession, edgeHeaders } from './session.ts';

type ChatOutcome =
  | 'streamed'
  | 'paused'
  | 'still-checking'
  | 'conflict'
  | 'refused'
  | 'stopped'
  | 'failed';

type ChatResult = {
  outcome: ChatOutcome;
  /** The HTTP status, or null when no answer came. */
  status: number | null;
  /** Why the server refused, when it said so: `arrival_paused`, `exchange_in_flight` and the like. */
  errorCode: string | null;
  firstByteMs: number;
  totalMs: number;
  /** Seconds the server asked us to wait, when it asked. */
  retryAfterSeconds: number | null;
};

/** Every request below ends at once when `signal` aborts. */
export async function signIn(
  plan: Plan,
  email: string,
  requests: UserRequests,
  signal: AbortSignal,
): Promise<Session> {
  return sessionFrom(plan, await tokensOf(plan, 'signin', email, requests, signal), {
    email,
    requests,
    signal,
  });
}

export async function signUp(
  plan: Plan,
  email: string,
  requests: UserRequests,
  signal: AbortSignal,
): Promise<Session> {
  return sessionFrom(plan, await tokensOf(plan, 'signup', email, requests, signal), {
    email,
    requests,
    signal,
  });
}

/** A session for a user who has just signed in; when its refresh token may be spent, it signs the same user in again. */
function sessionFrom(
  plan: Plan,
  tokens: Tokens,
  user: { email: string; requests: UserRequests; signal: AbortSignal },
): Session {
  const { email, requests, signal } = user;
  return createSession(plan, tokens, requests, {
    signal,
    signInAgain: () => tokensOf(plan, 'signin', email, requests, signal),
  });
}

const AUTH_PATHS = { signin: '/api/auth/signin', signup: '/api/auth/signup' } as const;

async function tokensOf(
  plan: Plan,
  kind: 'signin' | 'signup',
  email: string,
  requests: UserRequests,
  signal: AbortSignal,
): Promise<Tokens> {
  const path = AUTH_PATHS[kind];
  const clock = startStopwatch();
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
    signal,
  }).catch((error: unknown) => {
    requests.record(unanswered(kind, clock, signal));
    throw error;
  });
  const firstByteMs = clock.elapsedMs();
  const text = await bodyOrNull(response, signal);
  if (text === null) {
    requests.record(cutShort(kind, clock, { status: response.status, firstByteMs }));
    throw new Error('stopped');
  }
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {}
  const status = typeof body.status === 'string' ? body.status : undefined;
  const accessToken = response.headers.get('st-access-token');
  const refreshToken = response.headers.get('st-refresh-token');
  const succeeded = response.ok && status === 'OK' && accessToken !== null && refreshToken !== null;
  requests.record({
    kind,
    startedAt: clock.startedAt,
    firstByteMs,
    totalMs: clock.elapsedMs(),
    status: response.status,
    outcome: succeeded ? 'ok' : 'failed',
    errorCode: succeeded ? null : (status ?? null),
  });
  if (!succeeded) {
    const detail = status ? JSON.stringify(body) : text.slice(0, 200) || 'no body';
    throw new RequestFailed(`${path} (${detail})`, response.status);
  }
  return { accessToken, refreshToken };
}

export async function createThread(
  plan: Plan,
  session: Session,
  requests: UserRequests,
  signal: AbortSignal,
) {
  const reply = await refreshingOnce(session, (headers, mayRefresh) =>
    postThread(plan, headers, mayRefresh, requests, signal),
  );
  if (!reply.ok) throw new RequestFailed('create thread', reply.status);
  return threadSchema.pick({ id: true }).parse(JSON.parse(reply.body)).id;
}

async function postThread(
  plan: Plan,
  headers: Record<string, string>,
  mayRefresh: boolean,
  requests: UserRequests,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; body: string }> {
  const clock = startStopwatch();
  const response = await fetch(`${plan.targetUrl}${pathOf(createThreadEndpoint)}`, {
    method: createThreadEndpoint.method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}',
    signal,
  }).catch((error: unknown) => {
    requests.record(unanswered('thread', clock, signal));
    throw error;
  });
  const firstByteMs = clock.elapsedMs();
  const body = await bodyOrNull(response, signal);
  if (body === null) {
    requests.record(cutShort('thread', clock, { status: response.status, firstByteMs }));
    throw new Error('stopped');
  }
  requests.record({
    kind: 'thread',
    startedAt: clock.startedAt,
    firstByteMs,
    totalMs: clock.elapsedMs(),
    status: response.status,
    outcome: failedOrExpired(response, mayRefresh),
    errorCode: response.ok ? null : errorCodeOf(body),
  });
  return { ok: response.ok, status: response.status, body };
}

/** Sends one message and reads the reply stream to its end. */
export function sendChat(
  plan: Plan,
  session: Session,
  threadId: string,
  text: string,
  requests: UserRequests,
  signal: AbortSignal,
): Promise<ChatResult> {
  return postChat(
    plan,
    session,
    threadId,
    {
      trigger: 'submit-message',
      messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
    },
    'chat',
    requests,
    signal,
  );
}

/** Answers a paused message by keeping it in its Thread, as the UI's "continue" does. */
export function continuePaused(
  plan: Plan,
  session: Session,
  threadId: string,
  requests: UserRequests,
  signal: AbortSignal,
): Promise<ChatResult> {
  return postChat(
    plan,
    session,
    threadId,
    { trigger: 'regenerate-message', choice: 'continue' },
    'chat-continue',
    requests,
    signal,
  );
}

function postChat(
  plan: Plan,
  session: Session,
  threadId: string,
  body: ChatRequest,
  kind: 'chat' | 'chat-continue',
  requests: UserRequests,
  signal: AbortSignal,
): Promise<ChatResult> {
  return refreshingOnce(session, (headers, mayRefresh) =>
    postChatOnce(plan, headers, mayRefresh, threadId, body, kind, requests, signal),
  );
}

async function postChatOnce(
  plan: Plan,
  headers: Record<string, string>,
  mayRefresh: boolean,
  threadId: string,
  body: ChatRequest,
  kind: 'chat' | 'chat-continue',
  requests: UserRequests,
  signal: AbortSignal,
): Promise<ChatResult> {
  const clock = startStopwatch();
  const response = await fetch(`${plan.targetUrl}${pathOf(chat, { id: threadId })}`, {
    method: chat.method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }).catch(() => null);
  const firstByteMs = clock.elapsedMs();
  if (response === null) {
    requests.record(unanswered(kind, clock, signal));
    return {
      outcome: signal.aborted ? 'stopped' : 'failed',
      status: null,
      errorCode: signal.aborted ? null : 'unreachable',
      firstByteMs,
      totalMs: firstByteMs,
      retryAfterSeconds: null,
    };
  }
  const text = await bodyOrNull(response, signal);
  if (text === null) {
    requests.record(cutShort(kind, clock, { status: response.status, firstByteMs }));
    return {
      outcome: 'stopped',
      status: response.status,
      errorCode: null,
      firstByteMs,
      totalMs: clock.elapsedMs(),
      retryAfterSeconds: null,
    };
  }
  const errorCode = response.status === 200 ? null : errorCodeOf(text);
  const result: ChatResult = {
    outcome:
      response.status === 200 ? outcomeOfStream(text) : outcomeOf(response.status, errorCode),
    errorCode,
    status: response.status,
    firstByteMs,
    totalMs: clock.elapsedMs(),
    retryAfterSeconds: retryAfterOf(response),
  };
  requests.record({
    kind,
    startedAt: clock.startedAt,
    firstByteMs,
    totalMs: result.totalMs,
    status: response.status,
    outcome: isExpired(response, mayRefresh) ? 'expired' : result.outcome,
    errorCode: result.errorCode,
  });
  return result;
}

/**
 * A 200 is not always a reply. A message the Drift gate pauses gets its
 * verdict and no text, and waits for the user's choice; a reply that broke
 * mid-way ends on an error event.
 */
function outcomeOfStream(stream: string): ChatOutcome {
  if (stream.includes('"type":"error"')) return 'failed';
  if (stream.includes('"type":"text-delta"')) return 'streamed';
  if (stream.includes(`"type":"${VERDICT_PART_TYPE}"`)) return 'paused';
  return 'failed';
}

function errorCodeOf(body: string) {
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
 * Each stream is recorded as one request when it ends, with the time it
 * stayed open. A stream the server turns away as expired is opened again
 * once the session has been refreshed. Rejects when the stream cannot be
 * opened. A stream that opened and then broke resolves, and is recorded as
 * failed.
 */
export async function holdPush(
  plan: Plan,
  session: Session,
  signal: AbortSignal,
  onEvent: () => void,
  requests: UserRequests,
) {
  const mayRefresh = session.canRefresh();
  const sentWith = session.headers();
  const turnedAway = await holdStream(plan, sentWith, mayRefresh, signal, onEvent, requests);
  if (!turnedAway) return;
  await session.refreshAfterRejection(sentWith);
  await holdStream(plan, session.headers(), false, signal, onEvent, requests);
}

/** Holds one stream; true when the server turned it away as expired before it opened. */
async function holdStream(
  plan: Plan,
  headers: Record<string, string>,
  mayRefresh: boolean,
  signal: AbortSignal,
  onEvent: () => void,
  requests: UserRequests,
) {
  const clock = startStopwatch();
  let firstByteMs = 0;
  let status: number | null = null;
  let outcome: RequestOutcome = 'failed';
  try {
    const response = await fetch(`${plan.targetUrl}${pathOf(events)}`, {
      headers: { ...headers, accept: 'text/event-stream' },
      signal,
    });
    firstByteMs = clock.elapsedMs();
    status = response.status;
    if (isExpired(response, mayRefresh)) {
      await cancelled(response);
      outcome = 'expired';
      return true;
    }
    if (!response.ok || response.body === null) {
      await cancelled(response);
      throw new RequestFailed('push', response.status);
    }
    const decoder = new TextDecoder();
    const reader = createEventReader(onEvent);
    try {
      for await (const chunk of response.body) reader.feed(decoder.decode(chunk, { stream: true }));
      outcome = 'dropped';
    } catch {
      // The stream broke after it opened; its outcome stays failed.
    }
    return false;
  } finally {
    const totalMs = clock.elapsedMs();
    requests.record({
      kind: 'push',
      startedAt: clock.startedAt,
      firstByteMs: status === null ? totalMs : firstByteMs,
      totalMs,
      status,
      outcome: signal.aborted ? 'held' : outcome,
      errorCode: null,
    });
  }
}

/** Lets go of a response whose body is not wanted, so that its connection is freed. */
async function cancelled(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Runs one call, and when the server turns it away because the access
 * token expired, refreshes the session and runs it once more. A call the
 * refresh could not save answers as the rejected attempt did.
 */
async function refreshingOnce<R extends { status: number | null }>(
  session: Session,
  attempt: (headers: Record<string, string>, mayRefresh: boolean) => Promise<R>,
): Promise<R> {
  const mayRefresh = session.canRefresh();
  const sentWith = session.headers();
  const first = await attempt(sentWith, mayRefresh);
  if (first.status !== 401 || !mayRefresh) return first;
  try {
    await session.refreshAfterRejection(sentWith);
  } catch {
    return first;
  }
  return attempt(session.headers(), false);
}

/**
 * The server answers an expired access token with a 401, as it does a
 * session that is gone. Only a session that can still be refreshed treats
 * it as expired; any other 401 is a failure.
 */
function isExpired(response: Response, mayRefresh: boolean) {
  return mayRefresh && response.status === 401;
}

function failedOrExpired(response: Response, mayRefresh: boolean): RequestOutcome {
  if (response.ok) return 'ok';
  return isExpired(response, mayRefresh) ? 'expired' : 'failed';
}

function outcomeOf(status: number, errorCode: string | null): ChatOutcome {
  if (GATE_WAIT_CODES.some((code) => code === errorCode)) return 'still-checking';
  if (status === 409) return 'conflict';
  if (status === 429) return 'refused';
  return 'failed';
}

function retryAfterOf(response: Response) {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : null;
}
