import { z } from 'zod';
import type { Plan } from './plan.ts';
import { RequestFailed } from './requestFailed.ts';
import { type UserRequests, cutShort, startStopwatch, unanswered } from './requestLog.ts';
import { bodyOrNull } from './responseBody.ts';

/** The tokens a signed-in user holds. */
export type Tokens = { accessToken: string; refreshToken: string };

/** How long a refresh may take before it is given up on. */
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * A user's session. It carries header tokens rather than cookies, which
 * the backend accepts equally. Everything one user does shares one
 * session, so the user refreshes it once at a time.
 */
export type Session = {
  /** The headers that sign the next request with the newest access token. */
  headers: () => Record<string, string>;
  /** False once the auth core has ended the session, and a refresh could not bring it back. */
  canRefresh: () => boolean;
  /**
   * Renews the session after the server turned away a request that was
   * sent with `sentWith`. Callers that ask while a refresh runs share
   * it, and a caller whose request was sent with tokens that have since
   * been replaced returns at once. Rejects when the session cannot be renewed.
   */
  refreshAfterRejection: (sentWith: Record<string, string>) => Promise<void>;
};

/** The header that lets a request through the edge, when the run goes that way. */
export function edgeHeaders(plan: Plan) {
  return { [plan.loadKeyHeader]: plan.loadKey };
}

/**
 * Whether a failed refresh may have used up the refresh token. A refresh
 * that got no answer may have reached the auth core, which rotates the
 * token as it answers, and so does one the auth core failed to answer
 * well. Presenting a spent token looks like theft and ends the session.
 * So does a success that came without new tokens. An answer that says the
 * session is gone (401), or that refused the request outright, did not
 * spend it.
 */
function mayHaveSpentToken(error: unknown) {
  if (!(error instanceof RequestFailed)) return true;
  return error.status >= 500 || error.status < 300;
}

/**
 * A session for a user who has just signed in. When its refresh token may
 * have been spent, the session signs the user in afresh through
 * `signInAgain`. A refresh that takes longer than `refreshTimeoutMs` is
 * given up on. Once `signal` aborts, every request the session makes is
 * cut short.
 */
export function createSession({
  plan,
  tokens,
  requests,
  signal,
  signInAgain,
  refreshTimeoutMs = REFRESH_TIMEOUT_MS,
}: {
  plan: Plan;
  tokens: Tokens;
  requests: UserRequests;
  signal: AbortSignal;
  signInAgain: () => Promise<Tokens>;
  refreshTimeoutMs?: number;
}): Session {
  let current = tokens;
  /** The auth core has ended the session. */
  let ended = false;
  /** The refresh token may have been used up, so it is not presented again. */
  let maybeSpent = false;
  let running: Promise<void> | null = null;
  const headers = () => ({
    ...edgeHeaders(plan),
    authorization: `Bearer ${current.accessToken}`,
  });

  /** Renews the tokens: by refresh while the refresh token can be trusted, else by signing in. */
  async function renew() {
    if (!maybeSpent) {
      try {
        // The refresh token rotates, so it is presented once and the reply replaces it.
        current = await requestRefresh({
          plan,
          refreshToken: current.refreshToken,
          requests,
          stop: signal,
          timeoutMs: refreshTimeoutMs,
        });
        return;
      } catch (error) {
        // A 401 means the auth core has ended the session.
        if (error instanceof RequestFailed && error.status === 401) ended = true;
        if (signal.aborted || !mayHaveSpentToken(error)) throw error;
        maybeSpent = true;
      }
    }
    current = await signInAgain();
    maybeSpent = false;
  }

  return {
    headers,
    canRefresh: () => !ended,
    refreshAfterRejection(sentWith) {
      if (sentWith.authorization !== headers().authorization) return Promise.resolve();
      if (running !== null) return running;
      if (ended) return Promise.reject(new RequestFailed('session refresh', 401));
      const refresh = renew().finally(() => {
        running = null;
      });
      running = refresh;
      return refresh;
    },
  };
}

async function requestRefresh({
  plan,
  refreshToken,
  requests,
  stop,
  timeoutMs,
}: {
  plan: Plan;
  refreshToken: string;
  requests: UserRequests;
  stop: AbortSignal;
  timeoutMs: number;
}): Promise<Tokens> {
  const clock = startStopwatch();
  // A refresh that hangs holds the user's whole session, so it is given up on.
  const signal = AbortSignal.any([stop, AbortSignal.timeout(timeoutMs)]);
  const response = await fetch(`${plan.targetUrl}/api/auth/session/refresh`, {
    method: 'POST',
    headers: {
      ...edgeHeaders(plan),
      authorization: `Bearer ${refreshToken}`,
      rid: 'session',
      'st-auth-mode': 'header',
    },
    signal,
  }).catch((error: unknown) => {
    requests.record(unanswered({ kind: 'refresh', clock, signal: stop }));
    throw error;
  });
  const firstByteMs = clock.elapsedMs();
  const text = await bodyOrNull(response, stop);
  if (text === null) {
    requests.record(
      cutShort({ kind: 'refresh', clock, begun: { status: response.status, firstByteMs } }),
    );
    throw new Error('stopped');
  }
  const accessToken = response.headers.get('st-access-token');
  const renewedRefreshToken = response.headers.get('st-refresh-token');
  const renewed = response.ok && accessToken !== null && renewedRefreshToken !== null;
  requests.record({
    kind: 'refresh',
    startedAt: clock.startedAt,
    firstByteMs,
    totalMs: clock.elapsedMs(),
    status: response.status,
    outcome: renewed ? 'ok' : 'failed',
    errorCode: renewed ? null : messageOf(text),
  });
  if (!renewed) throw new RequestFailed('session refresh', response.status);
  return { accessToken, refreshToken: renewedRefreshToken };
}

/** What the auth core said went wrong, such as `unauthorised` or `token theft detected`. */
function messageOf(body: string) {
  try {
    return z.object({ message: z.string() }).parse(JSON.parse(body)).message;
  } catch {
    return null;
  }
}
