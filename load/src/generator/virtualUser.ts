import { type createSignedInUser, createUserClient } from './api.ts';
import type { Levels } from './levels.ts';
import { type Plan, emailOf, isChatting } from './plan.ts';
import type { UserRequests } from './requestLog.ts';
import { MAX_BACKOFF_SECONDS, backoffSeconds, pause, retried } from './retry.ts';
import { OFF_TOPIC_SHARE, messageOn, otherTopicThan, topicOf } from './topics.ts';

/** The signal of seeding, which runs to its end: nothing tells it to stop. */
const NEVER_STOPS = new AbortController().signal;

type SignedInUser = ReturnType<typeof createSignedInUser>;

/**
 * One account seeded: created, given a Thread, and one Exchange in it, so
 * restored databases start with realistic rows rather than empty tables.
 */
export async function seedUser({
  plan,
  userNumber,
  requests,
}: {
  plan: Plan;
  userNumber: number;
  requests: UserRequests;
}) {
  const client = createUserClient({ plan, requests, signal: NEVER_STOPS });
  const user = await client.signUp(emailOf(plan, userNumber));
  if (!isChatting(plan, userNumber)) return;
  const threadId = await user.createThread();
  await user.sendChat({ threadId, text: messageOn(topicOf(userNumber), 0) });
}

/**
 * One user for the length of a run: signs in, keeps a tab's push stream
 * open, and, if they are one of the chatting share, chats with a pause
 * between replies. A failed sign-in or Thread is tried again after a
 * growing pause, so an outage slows users down rather than losing them.
 * Everything stops when `signal` aborts. Every request is written to
 * `requests`.
 */
export async function runUser({
  plan,
  userNumber,
  levels,
  requests,
  signal,
}: {
  plan: Plan;
  userNumber: number;
  levels: Levels;
  requests: UserRequests;
  signal: AbortSignal;
}) {
  const client = createUserClient({ plan, requests, signal });
  const user = await retried(signal, () => client.signIn(emailOf(plan, userNumber)));
  if (user === null) return;
  await levels.during('usersSignedIn', async () => {
    const push = keepPushOpen({ user, levels, signal });
    if (isChatting(plan, userNumber)) {
      await levels.during('chattersActive', () =>
        chatUntilStopped({ plan, userNumber, user, signal }),
      );
    }
    await push;
  });
}

async function keepPushOpen({
  user,
  levels,
  signal,
}: {
  user: SignedInUser;
  levels: Levels;
  signal: AbortSignal;
}) {
  let failuresInARow = 0;
  while (!signal.aborted) {
    try {
      await levels.during('pushStreamsOpen', () => user.holdPush({ onEvent: () => undefined }));
      failuresInARow = 0;
    } catch {
      failuresInARow += 1;
    }
    await pause(backoffSeconds(failuresInARow), signal);
  }
}

async function chatUntilStopped({
  plan,
  userNumber,
  user,
  signal,
}: {
  plan: Plan;
  userNumber: number;
  user: SignedInUser;
  signal: AbortSignal;
}) {
  const newThread = () => retried(signal, () => user.createThread());
  let threadId = await newThread();
  let topic = topicOf(userNumber);
  for (let turn = 0; threadId !== null && !signal.aborted; turn += 1) {
    if (turn > 0 && Math.random() < OFF_TOPIC_SHARE) topic = otherTopicThan(topic);
    let result = await user.sendChat({ threadId, text: messageOn(topic, turn) });
    // The Drift gate asks whether a change of subject belongs here; this user says it does.
    if (result.outcome === 'paused') {
      result = await user.continuePaused({ threadId });
    }

    // A Thread that conflicted or failed is left as it is; the user starts afresh.
    if (result.outcome !== 'streamed' && result.outcome !== 'refused') {
      threadId = await newThread();
    }
    const backoff = Math.min(result.retryAfterSeconds ?? 0, MAX_BACKOFF_SECONDS);
    await pause(Math.max(plan.thinkSeconds, backoff), signal);
  }
}
