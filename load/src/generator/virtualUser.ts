import { continuePaused, createThread, holdPush, sendChat, signIn, signUp } from './api.ts';
import type { Levels } from './levels.ts';
import { type Plan, emailOf, isChatting } from './plan.ts';
import type { UserRequests } from './requestLog.ts';
import { MAX_BACKOFF_SECONDS, backoffSeconds, pause, retried } from './retry.ts';
import type { Session } from './session.ts';
import { OFF_TOPIC_SHARE, messageOn, otherTopicThan, topicOf } from './topics.ts';

/** The signal of seeding, which runs to its end: nothing tells it to stop. */
const NEVER_STOPS = new AbortController().signal;

/**
 * One account seeded: created, given a Thread, and one Exchange in it, so
 * restored databases start with realistic rows rather than empty tables.
 */
export async function seedUser(plan: Plan, userNumber: number, requests: UserRequests) {
  const signal = NEVER_STOPS;
  const session = await signUp(plan, emailOf(plan, userNumber), requests, signal);
  if (!isChatting(plan, userNumber)) return;
  const threadId = await createThread(plan, session, requests, signal);
  await sendChat(plan, session, threadId, messageOn(topicOf(userNumber), 0), requests, signal);
}

/**
 * One user for the length of a run: signs in, keeps a tab's push stream
 * open, and, if they are one of the chatting share, chats with a pause
 * between replies. A failed sign-in or Thread is tried again after a
 * growing pause, so an outage slows users down rather than losing them.
 * Everything stops when `signal` aborts. Every request is written to
 * `requests`.
 */
export async function runUser(
  plan: Plan,
  userNumber: number,
  levels: Levels,
  requests: UserRequests,
  signal: AbortSignal,
) {
  const session = await retried(signal, () =>
    signIn(plan, emailOf(plan, userNumber), requests, signal),
  );
  if (session === null) return;
  levels.move('usersSignedIn', 1);
  try {
    const push = keepPushOpen(plan, session, levels, requests, signal);
    if (isChatting(plan, userNumber)) {
      levels.move('chattersActive', 1);
      try {
        await chatUntilStopped(plan, userNumber, session, requests, signal);
      } finally {
        levels.move('chattersActive', -1);
      }
    }
    await push;
  } finally {
    levels.move('usersSignedIn', -1);
  }
}

async function keepPushOpen(
  plan: Plan,
  session: Session,
  levels: Levels,
  requests: UserRequests,
  signal: AbortSignal,
) {
  let failuresInARow = 0;
  while (!signal.aborted) {
    levels.move('pushStreamsOpen', 1);
    try {
      await holdPush(plan, session, signal, () => undefined, requests);
      failuresInARow = 0;
    } catch {
      failuresInARow += 1;
    } finally {
      levels.move('pushStreamsOpen', -1);
    }
    await pause(backoffSeconds(failuresInARow), signal);
  }
}

async function chatUntilStopped(
  plan: Plan,
  userNumber: number,
  session: Session,
  requests: UserRequests,
  signal: AbortSignal,
) {
  const newThread = () => retried(signal, () => createThread(plan, session, requests, signal));
  let threadId = await newThread();
  let topic = topicOf(userNumber);
  for (let turn = 0; threadId !== null && !signal.aborted; turn += 1) {
    if (turn > 0 && Math.random() < OFF_TOPIC_SHARE) topic = otherTopicThan(topic);
    let result = await sendChat(plan, session, threadId, messageOn(topic, turn), requests, signal);
    // The Drift gate asks whether a change of subject belongs here; this user says it does.
    if (result.outcome === 'paused') {
      result = await continuePaused(plan, session, threadId, requests, signal);
    }

    // A Thread that conflicted or failed is left as it is; the user starts afresh.
    if (result.outcome !== 'streamed' && result.outcome !== 'refused') {
      threadId = await newThread();
    }
    const backoff = Math.min(result.retryAfterSeconds ?? 0, MAX_BACKOFF_SECONDS);
    await pause(Math.max(plan.thinkSeconds, backoff), signal);
  }
}
