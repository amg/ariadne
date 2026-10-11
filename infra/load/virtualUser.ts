import { type Session, createThread, holdPush, sendChat, signIn, signUp } from './api.ts';
import type { Metrics } from './metrics.ts';
import { type Plan, emailOf, isChatting } from './plan.ts';

/**
 * Messages that stay on one topic, so the Drift gate mostly lets them
 * through: the run measures replies, not pauses.
 */
const MESSAGES = [
  'How do I keep a sourdough starter alive while travelling?',
  'Does feeding it rye flour change how sour the bread gets?',
  'What hydration would you start with for a first loaf?',
  'How long should the bulk ferment run in a warm kitchen?',
  'Why does my crust come out pale even at high heat?',
];

/** The longest a refused or still-checking user waits before trying again. */
const MAX_BACKOFF_SECONDS = 60;

/**
 * One account seeded: created, given a Thread, and one Exchange in it, so
 * restored databases start with realistic rows rather than empty tables.
 */
export async function seedUser(plan: Plan, userNumber: number, metrics: Metrics): Promise<void> {
  const session = await timed(metrics, 'signup', () => signUp(plan, emailOf(plan, userNumber)));
  if (!isChatting(plan, userNumber)) return;
  const threadId = await createThread(plan, session);
  const result = await sendChat(plan, session, threadId, MESSAGES[0] ?? 'Hello');
  metrics.count(`seed.chat.${result.outcome}`);
}

/**
 * One user for the length of a run: signs in, keeps a tab's push stream
 * open, and, if they are one of the chatting share, chats with a pause
 * between replies. Everything stops when `signal` aborts.
 */
export async function runUser(
  plan: Plan,
  userNumber: number,
  metrics: Metrics,
  signal: AbortSignal,
): Promise<void> {
  const session = await timed(metrics, 'signin', () => signIn(plan, emailOf(plan, userNumber)));
  const push = keepPushOpen(plan, session, metrics, signal);
  if (isChatting(plan, userNumber)) await chatUntilStopped(plan, session, metrics, signal);
  await push;
}

async function keepPushOpen(
  plan: Plan,
  session: Session,
  metrics: Metrics,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    metrics.gauge('push.open', 1);
    try {
      await holdPush(plan, session, signal, () => metrics.count('push.events'));
      if (!signal.aborted) metrics.count('push.dropped');
    } catch {
      if (!signal.aborted) metrics.count('push.failed');
    } finally {
      metrics.gauge('push.open', -1);
    }
    await pause(1, signal);
  }
}

async function chatUntilStopped(
  plan: Plan,
  session: Session,
  metrics: Metrics,
  signal: AbortSignal,
): Promise<void> {
  let threadId = await createThread(plan, session);
  for (let turn = 0; !signal.aborted; turn += 1) {
    const result = await sendChat(plan, session, threadId, MESSAGES[turn % MESSAGES.length] ?? '');
    metrics.count(`chat.${result.outcome}`);
    metrics.time('chat.firstByte', result.firstByteMs);
    if (result.outcome === 'streamed') metrics.time('chat.total', result.totalMs);

    // A Thread that paused, conflicted or failed is left as it is; the user starts afresh.
    if (result.outcome !== 'streamed' && result.outcome !== 'refused') {
      threadId = await createThread(plan, session);
    }
    const backoff = Math.min(result.retryAfterSeconds ?? 0, MAX_BACKOFF_SECONDS);
    await pause(Math.max(plan.thinkSeconds, backoff), signal);
  }
}

async function timed<T>(metrics: Metrics, name: string, work: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await work();
    metrics.count(`${name}.ok`);
    return result;
  } catch (error) {
    metrics.count(`${name}.failed`);
    throw error;
  } finally {
    metrics.time(name, performance.now() - startedAt);
  }
}

/** Resolves after `seconds`, or at once when `signal` aborts. */
export function pause(seconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, seconds * 1_000);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
