import {
  type ChatResult,
  type Session,
  continuePaused,
  createThread,
  holdPush,
  sendChat,
  signIn,
  signUp,
} from './api.ts';
import type { Metrics } from './metrics.ts';
import { type Plan, emailOf, isChatting } from './plan.ts';

/**
 * What users talk about. Each message carries the mock's `TOPIC:<name>`
 * marker, which gives messages on one topic nearby embeddings, so the
 * Drift gate lets a conversation run and fires when it changes topic.
 */
const TOPICS: Record<string, string[]> = {
  sourdough: [
    'How do I keep a sourdough starter alive while travelling?',
    'Does feeding it rye flour change how sour the bread gets?',
    'What hydration would you start with for a first loaf?',
    'How long should the bulk ferment run in a warm kitchen?',
    'Why does my crust come out pale even at high heat?',
  ],
  hiking: [
    'Which layers should I pack for a winter day hike?',
    'How do I tell if a mountain trail is too icy to continue?',
    'What is a sensible pace for a beginner on steep ground?',
    'How much water should I carry for six hours in the hills?',
    'Are trekking poles worth it on the way down?',
  ],
  espresso: [
    'Why does my espresso taste sour even with fresh beans?',
    'How fine should I grind for a double shot?',
    'Does the water temperature matter much for a light roast?',
    'How do I steam milk without big bubbles?',
    'How often should I descale a home machine?',
  ],
};
const TOPIC_NAMES = Object.keys(TOPICS);

/** The share of messages that change the subject, which the Drift gate should pause. */
const OFF_TOPIC_SHARE = 0.1;

/** The longest a refused or still-checking user waits before trying again. */
const MAX_BACKOFF_SECONDS = 60;

/** The first wait after a failure; each further failure in a row doubles it. */
const FIRST_RETRY_SECONDS = 1;

/**
 * One account seeded: created, given a Thread, and one Exchange in it, so
 * restored databases start with realistic rows rather than empty tables.
 */
export async function seedUser(plan: Plan, userNumber: number, metrics: Metrics): Promise<void> {
  const session = await timed(metrics, 'signup', () => signUp(plan, emailOf(plan, userNumber)));
  if (!isChatting(plan, userNumber)) return;
  const threadId = await createThread(plan, session);
  const result = await sendChat(plan, session, threadId, messageOn(topicOf(userNumber), 0));
  metrics.count(`seed.chat.${result.outcome}`);
}

/**
 * One user for the length of a run: signs in, keeps a tab's push stream
 * open, and, if they are one of the chatting share, chats with a pause
 * between replies. A failed sign-in or Thread is tried again after a
 * growing pause, so an outage slows users down rather than losing them.
 * Everything stops when `signal` aborts.
 */
export async function runUser(
  plan: Plan,
  userNumber: number,
  metrics: Metrics,
  signal: AbortSignal,
): Promise<void> {
  const session = await retried(metrics, 'signin', signal, () =>
    signIn(plan, emailOf(plan, userNumber)),
  );
  if (session === null) {
    metrics.count('signin.abandoned');
    return;
  }
  const push = keepPushOpen(plan, session, metrics, signal);
  if (isChatting(plan, userNumber)) {
    await chatUntilStopped(plan, userNumber, session, metrics, signal);
  }
  await push;
}

async function keepPushOpen(
  plan: Plan,
  session: Session,
  metrics: Metrics,
  signal: AbortSignal,
): Promise<void> {
  let failuresInARow = 0;
  while (!signal.aborted) {
    metrics.gauge('push.open', 1);
    try {
      await holdPush(plan, session, signal, () => metrics.count('push.events'));
      if (!signal.aborted) metrics.count('push.dropped');
      failuresInARow = 0;
    } catch {
      if (!signal.aborted) metrics.count('push.failed');
      failuresInARow += 1;
    } finally {
      metrics.gauge('push.open', -1);
    }
    await pause(backoffSeconds(failuresInARow), signal);
  }
}

async function chatUntilStopped(
  plan: Plan,
  userNumber: number,
  session: Session,
  metrics: Metrics,
  signal: AbortSignal,
): Promise<void> {
  const newThread = () => retried(metrics, 'thread', signal, () => createThread(plan, session));
  let threadId = await newThread();
  let topic = topicOf(userNumber);
  for (let turn = 0; threadId !== null && !signal.aborted; turn += 1) {
    if (turn > 0 && Math.random() < OFF_TOPIC_SHARE) topic = otherTopicThan(topic);
    let result = record(metrics, await sendChat(plan, session, threadId, messageOn(topic, turn)));
    // The Drift gate asks whether a change of subject belongs here; this user says it does.
    if (result.outcome === 'paused') {
      result = record(metrics, await continuePaused(plan, session, threadId));
    }

    // A Thread that conflicted or failed is left as it is; the user starts afresh.
    if (result.outcome !== 'streamed' && result.outcome !== 'refused') {
      threadId = await newThread();
    }
    const backoff = Math.min(result.retryAfterSeconds ?? 0, MAX_BACKOFF_SECONDS);
    await pause(Math.max(plan.thinkSeconds, backoff), signal);
  }
}

/** Counts the outcome, by reason when the server gave one, and times replies. */
function record(metrics: Metrics, result: ChatResult): ChatResult {
  const reason = result.errorCode === null ? '' : `.${result.errorCode}`;
  metrics.count(`chat.${result.outcome}${reason}`);
  if (result.outcome === 'streamed') {
    metrics.time('chat.firstByte', result.firstByteMs);
    metrics.time('chat.total', result.totalMs);
  }
  return result;
}

function topicOf(userNumber: number): string {
  return TOPIC_NAMES[userNumber % TOPIC_NAMES.length] ?? 'sourdough';
}

function otherTopicThan(topic: string): string {
  const others = TOPIC_NAMES.filter((name) => name !== topic);
  return others[Math.floor(Math.random() * others.length)] ?? topic;
}

function messageOn(topic: string, turn: number): string {
  const messages = TOPICS[topic] ?? [];
  return `${messages[turn % messages.length] ?? 'Tell me more.'} TOPIC:${topic}`;
}

/**
 * Runs `work` until it succeeds, pausing longer after each failure.
 * Resolves to null if `signal` aborts first.
 */
async function retried<T>(
  metrics: Metrics,
  name: string,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T | null> {
  for (let failures = 0; !signal.aborted; failures += 1) {
    try {
      return await timed(metrics, name, work);
    } catch {
      await pause(backoffSeconds(failures + 1), signal);
    }
  }
  return null;
}

/**
 * The pause after `failures` failures in a row: one second, doubling with
 * each further failure up to a minute. Each pause is spread over its
 * upper half, so users cut off together do not all return together.
 */
function backoffSeconds(failures: number): number {
  if (failures === 0) return FIRST_RETRY_SECONDS;
  const ceiling = Math.min(FIRST_RETRY_SECONDS * 2 ** (failures - 1), MAX_BACKOFF_SECONDS);
  return ceiling * (0.5 + Math.random() / 2);
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
