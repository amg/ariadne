import { randomUUID } from 'node:crypto';
import { insertMessage } from '@queries/messages/insertMessage';
import { insertThread } from '@queries/threads/insertThread';
import { insertUserIfNotExists } from '@queries/users/insertUserIfNotExists';
import { DRIFT_GATE_JUDGE_ARRIVAL } from '@queue/tasks/driftGateJudgeArrivalTask';
import { currentArrivalEvents, publish, subscribe } from '@services/events';
import { addDeadJob } from '@test/queue';
import { useTestDb } from '@test/test-db';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  await setupEventsGetRoute(app);
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

/** The event a raw SSE block carries, or null for a comment such as the heartbeat. */
function frameOrNull(block: string): Frame | null {
  if (block.startsWith(':')) return null;
  const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
  const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}');
  return { event, data };
}

/** The next text chunk off the stream, or a throw when none comes before the deadline. */
async function chunkBefore(
  reader: ReadableStreamDefaultReader<string>,
  deadline: number,
): Promise<string> {
  const chunk = await Promise.race([
    reader.read(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
  ]);
  if (chunk === null) throw new Error('no frame arrived');
  if (chunk.done) throw new Error('the stream ended');
  return chunk.value;
}

/** A browser tab's push connection: frames are parsed as they arrive. */
async function openTab(userId: string): Promise<Tab> {
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
