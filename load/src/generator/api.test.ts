import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedInUser, createUserClient } from './api.ts';
import type { Plan } from './plan.ts';
import type { UserRequests } from './requestLog.ts';

type RequestDetails = Parameters<UserRequests['record']>[0];

import type { Session } from './session.ts';

const plan = {
  targetUrl: 'http://app.test',
  loadKeyHeader: 'x-load-key',
  loadKey: 'key',
} as Plan; // sendChat reads only the target and the edge key.

const requests = { record: () => undefined };
const never = new AbortController().signal;

const session: Session = {
  headers: () => ({}),
  canRefresh: () => true,
  refreshAfterRejection: async () => undefined,
};

/** A signed-in user whose session is the stand-in above. */
function userOf({ requests, signal }: { requests: UserRequests; signal: AbortSignal }) {
  return createSignedInUser({ plan, requests, signal, session });
}

function answering(status: number, body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendChat', () => {
  it('reads a stream with text as a reply', async () => {
    answering(200, 'data: {"type":"text-delta","delta":"hi"}\n\n');
    const result = await userOf({ requests, signal: never }).sendChat({
      threadId: 'thread-1',
      text: 'hello',
    });
    expect(result.outcome).toBe('streamed');
  });

  it.each(['gate_pending', 'gate_failed'])(
    'reads a 503 with %s as still checking',
    async (code) => {
      answering(503, JSON.stringify({ error: 'wait', errorCode: code }));
      const result = await userOf({ requests, signal: never }).sendChat({
        threadId: 'thread-1',
        text: 'hello',
      });
      expect(result).toMatchObject({ outcome: 'still-checking', errorCode: code });
    },
  );

  it('reads a 503 from a missing provider as a failure', async () => {
    answering(503, JSON.stringify({ error: 'no', errorCode: 'provider_not_configured' }));
    const result = await userOf({ requests, signal: never }).sendChat({
      threadId: 'thread-1',
      text: 'hello',
    });
    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'provider_not_configured' });
  });

  it('reads a 409 as a conflict', async () => {
    answering(409, JSON.stringify({ error: 'busy', errorCode: 'exchange_in_flight' }));
    const result = await userOf({ requests, signal: never }).sendChat({
      threadId: 'thread-1',
      text: 'hello',
    });
    expect(result).toMatchObject({ outcome: 'conflict', errorCode: 'exchange_in_flight' });
  });
});

/**
 * A response whose body the test can watch being cancelled, and that never
 * ends by itself. As with a real one, the body fails when `signal` aborts.
 */
function watchedResponse(status: number, signal?: AbortSignal) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(signal.reason));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body, { status }), cancelled: () => cancelled };
}

/** A fetch that answers only when its signal aborts, which it reports as the real one does. */
function hangingUntilAborted() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ),
  );
}

function recording() {
  const lines: RequestDetails[] = [];
  return { lines, requests: { record: (details: RequestDetails) => lines.push(details) } };
}

describe('every request carries the stop signal', () => {
  it.each([
    [
      'a sign-in',
      'signin',
      (stop: AbortSignal, requests: UserRequests) =>
        createUserClient({ plan, requests, signal: stop }).signIn('a@b.c'),
    ],
    [
      'a sign-up',
      'signup',
      (stop: AbortSignal, requests: UserRequests) =>
        createUserClient({ plan, requests, signal: stop }).signUp('a@b.c'),
    ],
    [
      'a new thread',
      'thread',
      (stop: AbortSignal, requests: UserRequests) =>
        userOf({ requests, signal: stop }).createThread(),
    ],
    [
      'a chat',
      'chat',
      (stop: AbortSignal, requests: UserRequests) =>
        userOf({ requests, signal: stop }).sendChat({ threadId: 't', text: 'hi' }),
    ],
    [
      'a continued chat',
      'chat-continue',
      (stop: AbortSignal, requests: UserRequests) =>
        userOf({ requests, signal: stop }).continuePaused({ threadId: 't' }),
    ],
  ] as const)(
    'ends %s at once, recorded as stopped and not as a failure',
    async (_what, kind, call) => {
      hangingUntilAborted();
      const { lines, requests } = recording();
      const stop = new AbortController();

      const calling = call(stop.signal, requests).then(
        () => 'returned',
        () => 'rejected',
      );
      stop.abort();
      await calling;

      expect(lines).toMatchObject([{ kind, outcome: 'stopped', status: null, errorCode: null }]);
    },
  );

  it('records a reply cut short while its body was being read as stopped, with the status it had', async () => {
    const stop = new AbortController();
    const { response } = watchedResponse(200, stop.signal);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        queueMicrotask(() => stop.abort());
        return response;
      }),
    );
    const { lines, requests } = recording();

    const result = await userOf({ requests, signal: stop.signal }).sendChat({
      threadId: 't',
      text: 'hi',
    });

    expect(result).toMatchObject({ outcome: 'stopped', status: 200 });
    expect(lines).toMatchObject([{ kind: 'chat', outcome: 'stopped', status: 200 }]);
    expect(lines[0]?.firstByteMs).toBe(result.firstByteMs);
  });

  it('still records a request with no answer as a failure when the run has not been told to stop', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('reset')));
    const { lines, requests } = recording();

    const result = await userOf({ requests, signal: never }).sendChat({
      threadId: 't',
      text: 'hi',
    });

    expect(result).toMatchObject({ outcome: 'failed', errorCode: 'unreachable' });
    expect(lines).toMatchObject([{ outcome: 'failed', errorCode: 'unreachable' }]);
  });
});

describe('holdPush', () => {
  it('lets go of the body of a stream the server turned away as expired', async () => {
    const turnedAway = watchedResponse(401);
    const opened = new Response('data: {}\n\n');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(turnedAway.response).mockResolvedValueOnce(opened),
    );
    const { requests } = recording();

    await userOf({ requests, signal: never }).holdPush({ onEvent: () => undefined });

    expect(turnedAway.cancelled()).toBe(true);
  });

  it('lets go of the body of a stream the server refused, and fails', async () => {
    const refused = watchedResponse(503);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(refused.response));
    const { lines, requests } = recording();

    await expect(
      userOf({ requests, signal: never }).holdPush({ onEvent: () => undefined }),
    ).rejects.toThrow('503');

    expect(refused.cancelled()).toBe(true);
    expect(lines).toMatchObject([{ kind: 'push', outcome: 'failed', status: 503 }]);
  });

  it('resolves when a stream breaks after it opened, recorded as failed with its status', async () => {
    const broken = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
          controller.error(new TypeError('terminated'));
        },
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(broken));
    const { lines, requests } = recording();

    await userOf({ requests, signal: never }).holdPush({ onEvent: () => undefined });

    expect(lines).toMatchObject([{ kind: 'push', outcome: 'failed', status: 200 }]);
  });

  it('counts an event once when its line arrives in two pieces', async () => {
    const encoder = new TextEncoder();
    const pieces = ['da', 'ta: {"a"', ':1}\n\ndata: {}\n', '\n: heartbeat\n\n'];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const piece of pieces) controller.enqueue(encoder.encode(piece));
                controller.close();
              },
            }),
          ),
      ),
    );
    let events = 0;
    const { requests } = recording();

    await userOf({ requests, signal: never }).holdPush({
      onEvent: () => {
        events += 1;
      },
    });

    expect(events).toBe(2);
  });
});
