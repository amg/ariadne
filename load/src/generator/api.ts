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

/** What stays the same for every request one user makes. */
type UserContext = { plan: Plan; requests: UserRequests; signal: AbortSignal };

/** What one attempt is sent with: the session's headers, and whether a 401 means the access token expired. */
type Credentials = { headers: Record<string, string>; mayRefresh: boolean };

/** Signs one user up or in. Every request the user makes ends at once when `signal` aborts. */
export function createUserClient(context: UserContext) {
  const { plan, requests, signal } = context;
  const tokensOf = tokensRequest(context);
  const signedIn = async ({ kind, email }: { kind: 'signin' | 'signup'; email: string }) => {
    const tokens = await tokensOf({ kind, email });
    // When the refresh token may be spent, the same user signs in again.
    const session = createSession({
      plan,
      tokens,
      requests,
      signal,
      signInAgain: () => tokensOf({ kind: 'signin', email }),
    });
    return createSignedInUser({ ...context, session });
  };
  return {
    signIn: (email: string) => signedIn({ kind: 'signin', email }),
    signUp: (email: string) => signedIn({ kind: 'signup', email }),
  };
}

/** A user who has signed in, and what they do with their session. */
export function createSignedInUser({ session, ...context }: UserContext & { session: Session }) {
  const postThread = threadRequest(context);
  const postChatOnce = chatRequest(context);
  const holdStream = pushRequest(context);

  const postChat = ({
    threadId,
    body,
    kind,
  }: {
    threadId: string;
    body: ChatRequest;
    kind: 'chat' | 'chat-continue';
  }) =>
    refreshingOnce(session, (credentials) => postChatOnce({ credentials, threadId, body, kind }));

  return {
    async createThread() {
      const reply = await refreshingOnce(session, postThread);
      if (!reply.ok) throw new RequestFailed('create thread', reply.status);
      return threadSchema.pick({ id: true }).parse(JSON.parse(reply.body)).id;
    },

    /** Sends one message and reads the reply stream to its end. */
    sendChat: ({ threadId, text }: { threadId: string; text: string }) =>
      postChat({
        threadId,
        body: {
          trigger: 'submit-message',
          messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        },
        kind: 'chat',
      }),

    /** Answers a paused message by keeping it in its Thread, as the UI's "continue" does. */
    continuePaused: ({ threadId }: { threadId: string }) =>
      postChat({
        threadId,
        body: { trigger: 'regenerate-message', choice: 'continue' },
        kind: 'chat-continue',
      }),

    /**
     * Holds the user's push stream open until it ends or the user's signal
     * aborts, calling `onEvent` for each event that arrives. Heartbeats are
     * not events. Each stream is recorded as one request when it ends, with
     * the time it stayed open. A stream the server turns away as expired is
     * opened again once the session has been refreshed. Rejects when the
     * stream cannot be opened. A stream that opened and then broke resolves,
     * and is recorded as failed.
     */
    async holdPush({ onEvent }: { onEvent: () => void }) {
      const mayRefresh = session.canRefresh();
      const sentWith = session.headers();
      const turnedAway = await holdStream({
        credentials: { headers: sentWith, mayRefresh },
        onEvent,
      });
      if (!turnedAway) return;
      await session.refreshAfterRejection(sentWith);
      await holdStream({ credentials: { headers: session.headers(), mayRefresh: false }, onEvent });
    },
  };
}

const AUTH_PATHS = { signin: '/api/auth/signin', signup: '/api/auth/signup' } as const;

function tokensRequest({ plan, requests, signal }: UserContext) {
  return async function tokensOf({
    kind,
    email,
  }: {
    kind: 'signin' | 'signup';
    email: string;
  }): Promise<Tokens> {
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
      requests.record(unanswered({ kind, clock, signal }));
      throw error;
    });
    const firstByteMs = clock.elapsedMs();
    const text = await bodyOrNull(response, signal);
    if (text === null) {
      requests.record(cutShort({ kind, clock, begun: { status: response.status, firstByteMs } }));
      throw new Error('stopped');
    }
    const { body, status, tokens } = authReplyOf({ response, text });
    const succeeded = tokens !== null;
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
    return tokens;
  };
}

/** What the auth core answered: the status it names, and the tokens when the answer is a success that carries both. */
function authReplyOf({ response, text }: { response: Response; text: string }) {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {}
  const status = typeof body.status === 'string' ? body.status : undefined;
  const accessToken = response.headers.get('st-access-token');
  const refreshToken = response.headers.get('st-refresh-token');
  const succeeded = response.ok && status === 'OK' && accessToken !== null && refreshToken !== null;
  const tokens: Tokens | null = succeeded ? { accessToken, refreshToken } : null;
  return { body, status, tokens };
}

function threadRequest({ plan, requests, signal }: UserContext) {
  return async function postThread({
    headers,
    mayRefresh,
  }: Credentials): Promise<{ ok: boolean; status: number; body: string }> {
    const clock = startStopwatch();
    const response = await fetch(`${plan.targetUrl}${pathOf(createThreadEndpoint)}`, {
      method: createThreadEndpoint.method,
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{}',
      signal,
    }).catch((error: unknown) => {
      requests.record(unanswered({ kind: 'thread', clock, signal }));
      throw error;
    });
    const firstByteMs = clock.elapsedMs();
    const body = await bodyOrNull(response, signal);
    if (body === null) {
      requests.record(
        cutShort({ kind: 'thread', clock, begun: { status: response.status, firstByteMs } }),
      );
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
  };
}

function replyResultOf({
  response,
  text,
  firstByteMs,
  clock,
}: {
  response: Response;
  text: string;
  firstByteMs: number;
  clock: ReturnType<typeof startStopwatch>;
}): ChatResult {
  const errorCode = response.status === 200 ? null : errorCodeOf(text);
  return {
    outcome:
      response.status === 200 ? outcomeOfStream(text) : outcomeOf(response.status, errorCode),
    errorCode,
    status: response.status,
    firstByteMs,
    totalMs: clock.elapsedMs(),
    retryAfterSeconds: retryAfterOf(response),
  };
}

function chatRequest({ plan, requests, signal }: UserContext) {
  return async function postChatOnce({
    credentials: { headers, mayRefresh },
    threadId,
    body,
    kind,
  }: {
    credentials: Credentials;
    threadId: string;
    body: ChatRequest;
    kind: 'chat' | 'chat-continue';
  }): Promise<ChatResult> {
    const clock = startStopwatch();
    const response = await fetch(`${plan.targetUrl}${pathOf(chat, { id: threadId })}`, {
      method: chat.method,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }).catch(() => null);
    const firstByteMs = clock.elapsedMs();
    if (response === null) {
      requests.record(unanswered({ kind, clock, signal }));
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
      requests.record(cutShort({ kind, clock, begun: { status: response.status, firstByteMs } }));
      return {
        outcome: 'stopped',
        status: response.status,
        errorCode: null,
        firstByteMs,
        totalMs: clock.elapsedMs(),
        retryAfterSeconds: null,
      };
    }
    const result = replyResultOf({ response, text, firstByteMs, clock });
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

function pushRequest({ plan, requests, signal }: UserContext) {
  /** Holds one stream; true when the server turned it away as expired before it opened. */
  return async function holdStream({
    credentials: { headers, mayRefresh },
    onEvent,
  }: {
    credentials: Credentials;
    onEvent: () => void;
  }) {
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
        for await (const chunk of response.body) {
          reader.feed(decoder.decode(chunk, { stream: true }));
        }
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
  };
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
  attempt: (credentials: Credentials) => Promise<R>,
): Promise<R> {
  const mayRefresh = session.canRefresh();
  const sentWith = session.headers();
  const first = await attempt({ headers: sentWith, mayRefresh });
  if (first.status !== 401 || !mayRefresh) return first;
  try {
    await session.refreshAfterRejection(sentWith);
  } catch {
    return first;
  }
  return attempt({ headers: session.headers(), mayRefresh: false });
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
