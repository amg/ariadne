import { pathOf } from '@ari/lib/api/schemas/common/endpoint';
import { events } from '@ari/lib/api/schemas/events/events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedInUser } from './api.ts';
import type { Plan } from './plan.ts';
import type { UserRequests } from './requestLog.ts';

type RequestDetails = Parameters<UserRequests['record']>[0];

import { createSession } from './session.ts';

const plan = {
  targetUrl: 'http://app.test',
  loadKeyHeader: 'x-load-key',
  loadKey: 'key',
} as Plan; // The calls read only the target and the edge key.

/**
 * A stand-in for the app and its auth core. An access token works only
 * while it is the newest one issued. A refresh token works once: the
 * auth core treats a spent one as theft, and ends the session.
 */
function authCore() {
  let accessNumber = 0;
  let refreshNumber = 0;
  const refreshesSeen: string[] = [];
  let sessionEnded = false;

  const refresh = async (presented: string | null): Promise<Response> => {
    refreshesSeen.push(presented ?? 'none');
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (sessionEnded || presented !== `Bearer refresh-${refreshNumber}`) {
      sessionEnded = true;
      return new Response(JSON.stringify({ message: 'token theft detected' }), { status: 401 });
    }
    accessNumber += 1;
    refreshNumber += 1;
    return new Response('{}', {
      headers: {
        'st-access-token': `access-${accessNumber}`,
        'st-refresh-token': `refresh-${refreshNumber}`,
      },
    });
  };

  const answer = async (url: string, init: RequestInit | undefined): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (url.endsWith('/api/auth/session/refresh')) return refresh(headers.get('authorization'));
    if (sessionEnded || headers.get('authorization') !== `Bearer access-${accessNumber}`) {
      return new Response(JSON.stringify({ message: 'try refresh token' }), { status: 401 });
    }
    if (url.endsWith(pathOf(events))) return new Response('event: x\ndata: {}\n\n');
    return new Response('data: {"type":"text-delta","delta":"hi"}\n\n');
  };

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => answer(url, init)),
  );
  const signedInAgain: string[] = [];
  return {
    tokens: { accessToken: 'access-0', refreshToken: 'refresh-0' },
    refreshesSeen,
    /** Signs a user in afresh, as the auth core does: a new session, with tokens that work. */
    signInAgain: async () => {
      signedInAgain.push('signed in');
      sessionEnded = false;
      accessNumber += 1;
      refreshNumber += 1;
      return { accessToken: `access-${accessNumber}`, refreshToken: `refresh-${refreshNumber}` };
    },
    signedInAgain,
    expireAccessToken: () => {
      accessNumber += 1;
    },
  };
}

const never = new AbortController().signal;

const sessionInputs = (core: ReturnType<typeof authCore>) => ({
  plan,
  tokens: core.tokens,
  signal: never,
  signInAgain: core.signInAgain,
});

function recorder() {
  const lines: RequestDetails[] = [];
  return { lines, requests: { record: (details: RequestDetails) => lines.push(details) } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a session that expires while its user is busy', () => {
  it('refreshes once when the push stream and a chat need it at the same moment, and both carry on', async () => {
    const core = authCore();
    const { lines, requests } = recorder();
    const session = createSession({ ...sessionInputs(core), requests });
    core.expireAccessToken();
    let eventsSeen = 0;

    const user = createSignedInUser({ plan, requests, signal: never, session });

    const [, reply] = await Promise.all([
      user.holdPush({ onEvent: () => eventsSeen++ }),
      user.sendChat({ threadId: 'thread-1', text: 'hello' }),
    ]);

    expect(core.refreshesSeen).toEqual(['Bearer refresh-0']);
    expect(reply.outcome).toBe('streamed');
    expect(eventsSeen).toBe(1);
    expect(lines.filter((line) => line.kind === 'refresh')).toMatchObject([
      { outcome: 'ok', status: 200 },
    ]);
    expect(
      lines
        .filter((line) => line.outcome === 'expired')
        .map((line) => line.kind)
        .sort(),
    ).toEqual(['chat', 'push']);
  });

  it('does not refresh again for a request that was sent before the first refresh landed', async () => {
    const core = authCore();
    const { requests } = recorder();
    const session = createSession({ ...sessionInputs(core), requests });
    core.expireAccessToken();
    const sentWith = session.headers();

    await session.refreshAfterRejection(sentWith);
    await session.refreshAfterRejection(sentWith);

    expect(core.refreshesSeen).toHaveLength(1);
  });

  it('refreshes again when a later token expires, presenting the newest refresh token', async () => {
    const core = authCore();
    const { requests } = recorder();
    const session = createSession({ ...sessionInputs(core), requests });

    const user = createSignedInUser({ plan, requests, signal: never, session });

    core.expireAccessToken();
    await user.sendChat({ threadId: 'thread-1', text: 'hello' });
    core.expireAccessToken();
    const reply = await user.sendChat({ threadId: 'thread-1', text: 'hello again' });

    expect(core.refreshesSeen).toEqual(['Bearer refresh-0', 'Bearer refresh-1']);
    expect(reply.outcome).toBe('streamed');
  });
});

describe('a session the auth core ends', () => {
  it('records the failed refresh, never presents its refresh token again, and fails the calls that need it', async () => {
    const core = authCore();
    const { lines, requests } = recorder();
    const session = createSession({
      ...sessionInputs(core),
      tokens: { ...core.tokens, refreshToken: 'refresh-spent' },
      requests,
    });
    core.expireAccessToken();

    const user = createSignedInUser({ plan, requests, signal: never, session });

    const first = await user.sendChat({ threadId: 'thread-1', text: 'hello' });
    const second = await user.sendChat({ threadId: 'thread-1', text: 'hello' });

    expect(first.outcome).toBe('failed');
    expect(second.outcome).toBe('failed');
    expect(core.refreshesSeen).toEqual(['Bearer refresh-spent']);
    expect(session.canRefresh()).toBe(false);
    expect(lines.filter((line) => line.kind === 'refresh')).toMatchObject([
      { outcome: 'failed', status: 401, errorCode: 'token theft detected' },
    ]);
    expect(lines.filter((line) => line.kind === 'chat').map((line) => line.outcome)).toEqual([
      'expired',
      'failed',
    ]);
  });

  it('keeps the session, and its refresh token, when the auth core refuses a refresh without spending it', async () => {
    const core = authCore();
    const { requests } = recorder();
    const session = createSession({ ...sessionInputs(core), requests });
    core.expireAccessToken();
    const reachable = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 429 })),
    );

    await expect(session.refreshAfterRejection(session.headers())).rejects.toThrow('429');
    expect(session.canRefresh()).toBe(true);

    vi.stubGlobal('fetch', reachable);
    await session.refreshAfterRejection(session.headers());
    expect(core.refreshesSeen).toEqual(['Bearer refresh-0']);
    expect(core.signedInAgain).toEqual([]);
  });
});

describe('a refresh that may have spent the refresh token', () => {
  async function refreshedWhen(failure: () => Promise<Response>) {
    const core = authCore();
    const { lines, requests } = recorder();
    const session = createSession({ ...sessionInputs(core), requests });
    core.expireAccessToken();
    const reachable = fetch;
    vi.stubGlobal('fetch', vi.fn(failure));
    await session.refreshAfterRejection(session.headers());
    vi.stubGlobal('fetch', reachable);
    return { core, lines, session };
  }

  it('is treated as spent when the auth core could not be reached: the user signs in again and the token is never presented twice', async () => {
    const { core, lines, session } = await refreshedWhen(async () => {
      throw new Error('connection reset');
    });

    expect(core.signedInAgain).toEqual(['signed in']);
    expect(session.canRefresh()).toBe(true);
    expect(lines.filter((line) => line.kind === 'refresh')).toMatchObject([
      { outcome: 'failed', status: null, errorCode: 'unreachable' },
    ]);
    core.expireAccessToken();
    await session.refreshAfterRejection(session.headers());
    expect(core.refreshesSeen).toEqual(['Bearer refresh-1']);
  });

  it('is treated as spent when the auth core answered success without new tokens', async () => {
    const { core } = await refreshedWhen(async () => new Response('{}', { status: 200 }));

    expect(core.signedInAgain).toEqual(['signed in']);
  });

  it('is treated as spent when the auth core failed to answer well', async () => {
    const { core } = await refreshedWhen(async () => new Response('{}', { status: 503 }));

    expect(core.signedInAgain).toEqual(['signed in']);
  });

  it('is treated as spent when it takes longer than the refresh timeout, and is cut short', async () => {
    const core = authCore();
    const { lines, requests } = recorder();
    const session = createSession({
      ...sessionInputs(core),
      requests,
      refreshTimeoutMs: 30,
    });
    core.expireAccessToken();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );

    await session.refreshAfterRejection(session.headers());

    expect(core.signedInAgain).toEqual(['signed in']);
    expect(lines.filter((line) => line.kind === 'refresh')).toMatchObject([
      { outcome: 'failed', errorCode: 'unreachable' },
    ]);
  });

  it('signs in again at the next try when the sign-in itself could not be made, and not before', async () => {
    const core = authCore();
    const { requests } = recorder();
    let signIns = 0;
    const session = createSession({
      ...sessionInputs(core),
      requests,
      signInAgain: async () => {
        signIns += 1;
        if (signIns === 1) throw new Error('down');
        return core.signInAgain();
      },
    });
    core.expireAccessToken();
    const reachable = fetch;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));

    await expect(session.refreshAfterRejection(session.headers())).rejects.toThrow('down');
    vi.stubGlobal('fetch', reachable);
    await session.refreshAfterRejection(session.headers());

    expect(signIns).toBe(2);
    expect(core.refreshesSeen).toEqual([]);
  });

  it('does not sign in again for a run that has been told to stop', async () => {
    const core = authCore();
    const { requests } = recorder();
    const stop = new AbortController();
    const session = createSession({
      ...sessionInputs(core),
      requests,
      signal: stop.signal,
    });
    core.expireAccessToken();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        stop.abort();
        throw new DOMException('aborted', 'AbortError');
      }),
    );

    await expect(session.refreshAfterRejection(session.headers())).rejects.toThrow();

    expect(core.signedInAgain).toEqual([]);
  });
});

describe('a refresh cut short by the stop signal', () => {
  it('is recorded as stopped, not failed, when the stop came while its reply was being read', async () => {
    const core = authCore();
    const { lines, requests } = recorder();
    const stop = new AbortController();
    const session = createSession({
      ...sessionInputs(core),
      requests,
      signal: stop.signal,
    });
    core.expireAccessToken();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        queueMicrotask(() => stop.abort());
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stop.signal.addEventListener('abort', () => controller.error(stop.signal.reason));
            },
          }),
          { status: 500 },
        );
      }),
    );

    await expect(session.refreshAfterRejection(session.headers())).rejects.toThrow();

    expect(lines.filter((line) => line.kind === 'refresh')).toMatchObject([
      { outcome: 'stopped', status: 500 },
    ]);
    expect(core.signedInAgain).toEqual([]);
  });
});
