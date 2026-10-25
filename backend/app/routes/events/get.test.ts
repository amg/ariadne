import { randomUUID } from 'node:crypto';
import { PUSH_RECONNECT_SPREAD_MS } from '@ari/lib/api/schemas/events/events';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { DRIFT_GATE_JUDGE_ARRIVAL } from '@queue/tasks/driftGateJudgeArrivalTask';
import { currentArrivalEvents, publish, subscribe } from '@services/events';
import { addDeadJob } from '@test/queue';
import { useTestDb } from '@test/test-db';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pushStreamsOpen } from '../../pushStreams';
import { setupEventsGetRoute } from './get';

/** The session service is out of process; each request names its user in a header instead. */
vi.mock('supertokens-node/recipe/session/framework/fastify', () => ({
  verifySession:
    () =>
    async (request: { headers: Record<string, unknown>; session?: unknown }): Promise<void> => {
      const userId = String(request.headers['x-test-user']);
      request.session = { getUserId: () => userId };
    },
}));

/** The real bus and snapshot, wrapped so a test can slow the snapshot or watch unsubscribes. */
vi.mock('@services/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/events')>();
  return {
    ...actual,
    subscribe: vi.fn(actual.subscribe),
    currentArrivalEvents: vi.fn(actual.currentArrivalEvents),
  };
});

const actualEvents = await vi.importActual<typeof import('@services/events')>('@services/events');

useTestDb();

let app: FastifyInstance;
let baseUrl: string;
const openTabs: Tab[] = [];

beforeAll(async () => {
  app = Fastify({ logger: false });
  setupEventsGetRoute(app);
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(() => {
  for (const tab of openTabs.splice(0)) tab.close();
});

afterAll(async () => {
  await app.close();
});

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

interface Tab {
  /** Resolves with the next frame, or throws when none arrives in time. */
  nextFrame(): Promise<Frame>;
  close(): void;
}

/** The event a raw SSE block carries, or null for a block with no event: a comment or the reconnect wait. */
function frameOrNull(block: string) {
  if (block.startsWith(':') || block.startsWith('retry:')) return null;
  const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
  const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}');
  return { event, data };
}

/** The next text chunk off the stream, or a throw when none comes before the deadline. */
async function chunkBefore(reader: ReadableStreamDefaultReader<string>, deadline: number) {
  const chunk = await Promise.race([
    reader.read(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
  ]);
  if (chunk === null) throw new Error('no frame arrived');
  if (chunk.done) throw new Error('the stream ended');
  return chunk.value;
}

/** A browser tab's push connection: frames are parsed as they arrive. */
async function openTab(userId: string) {
  const abort = new AbortController();
  const response = await fetch(`${baseUrl}/api/events`, {
    headers: { 'x-test-user': userId },
    signal: abort.signal,
  });
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const body = response.body;
  if (!body) throw new Error('the stream has no body');
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';

  async function nextFrame(): Promise<Frame> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const end = buffered.indexOf('\n\n');
      if (end < 0) {
        buffered += await chunkBefore(reader, deadline);
        continue;
      }
      const frame = frameOrNull(buffered.slice(0, end));
      buffered = buffered.slice(end + 2);
      if (frame) return frame;
    }
  }

  const tab = { nextFrame, close: () => abort.abort() };
  openTabs.push(tab);
  return tab;
}

async function freshThread() {
  const userId = randomUUID();
  await insertUserIfNotExists({ id: userId });
  const { id: threadId } = await insertThread({ userId, title: 'Push' });
  return { userId, threadId };
}

describe('GET /api/events', () => {
  it('delivers a user\u2019s news to every open tab, without the user, and to no one else', async () => {
    const { userId, threadId } = await freshThread();
    const other = await freshThread();
    const first = await openTab(userId);
    const second = await openTab(userId);
    const stranger = await openTab(other.userId);

    publish({ kind: 'thread-titled', userId, threadId, title: 'Alpine hikes' });
    publish({
      kind: 'thread-titled',
      userId: other.userId,
      threadId: other.threadId,
      title: 'Mine',
    });

    const expected = {
      event: 'thread-titled',
      data: { kind: 'thread-titled', threadId, title: 'Alpine hikes' },
    };
    expect(await first.nextFrame()).toEqual(expected);
    expect(await second.nextFrame()).toEqual(expected);
    expect(await stranger.nextFrame()).toMatchObject({ data: { title: 'Mine' } });
  });

  it('re-emits the state an arrival sits in on every new connection', async () => {
    const { userId, threadId } = await freshThread();
    const arrival = await insertMessage({ threadId, role: 'user', content: 'Died on the gate' });
    await addDeadJob({
      task: DRIFT_GATE_JUDGE_ARRIVAL,
      key: arrival.id,
      payload: { userId, threadId, messageId: arrival.id },
      errorClass: 'fatal',
    });
    const expected = {
      event: 'gate-failed',
      data: { kind: 'gate-failed', threadId, messageId: arrival.id },
    };

    const before = await openTab(userId);
    expect(await before.nextFrame()).toEqual(expected);
    before.close();

    const after = await openTab(userId);
    expect(await after.nextFrame()).toEqual(expected);
  });

  it('tells each tab its own wait before it redials, drawn from the reconnect spread', async () => {
    const { userId } = await freshThread();
    const waitOf = async (random: number): Promise<number> => {
      const drawn = vi.spyOn(Math, 'random').mockReturnValue(random);
      const abort = new AbortController();
      try {
        const response = await fetch(`${baseUrl}/api/events`, {
          headers: { 'x-test-user': userId },
          signal: abort.signal,
        });
        const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
        if (!reader) throw new Error('the stream has no body');
        const first = await chunkBefore(reader, Date.now() + 2_000);
        return Number(/^retry: (\d+)\n\n/.exec(first)?.[1]);
      } finally {
        abort.abort();
        drawn.mockRestore();
      }
    };

    expect(await waitOf(0)).toBe(0);
    expect(await waitOf(0.5)).toBe(PUSH_RECONNECT_SPREAD_MS / 2);
    expect(await waitOf(0.999999)).toBe(PUSH_RECONNECT_SPREAD_MS - 1);
  });

  it('counts the streams open on this copy, from the moment their headers go out until they close', async () => {
    const { userId } = await freshThread();
    const baseline = pushStreamsOpen();

    const first = await openTab(userId);
    const second = await openTab(userId);
    expect(pushStreamsOpen()).toBe(baseline + 2);

    first.close();
    await vi.waitFor(() => expect(pushStreamsOpen()).toBe(baseline + 1));
    second.close();
    await vi.waitFor(() => expect(pushStreamsOpen()).toBe(baseline));
  });

  it('releases the subscription of a tab that leaves during the connect snapshot', async () => {
    const { userId } = await freshThread();
    let releaseSnapshot = () => {};
    const snapshotStarted = new Promise<void>((started) => {
      vi.mocked(currentArrivalEvents).mockImplementationOnce(() => {
        started();
        return new Promise((resolve) => {
          releaseSnapshot = () => resolve([]);
        });
      });
    });
    const unsubscribed = vi.fn();
    vi.mocked(subscribe).mockImplementationOnce((subscriber, handle) => {
      const subscription = actualEvents.subscribe(subscriber, handle);
      return {
        ready: subscription.ready,
        close: () => {
          subscription.close();
          unsubscribed();
        },
      };
    });

    const tab = await openTab(userId);
    await snapshotStarted;
    tab.close();

    try {
      await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledOnce());
    } finally {
      releaseSnapshot();
    }
  });
});
