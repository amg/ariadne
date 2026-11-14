import type { Levels } from './levels.ts';
import type { Plan } from './plan.ts';
import type { createRequestLog } from './requestLog.ts';
import { pause } from './retry.ts';
import { runUser } from './virtualUser.ts';

type RequestLog = ReturnType<typeof createRequestLog>;

/**
 * The longest a generator waits for its users to stop once it has been
 * told to. Every request they make ends at once when they are told, so
 * only a user stuck elsewhere takes longer. The wait leaves most of the
 * time a stopped task is given for the report to be written.
 */
const STOP_WITHIN_MS = 20_000;

/**
 * Brings the plan's users up evenly over the ramp, holds them for the hold,
 * then lets them go over the fall, one at a time and evenly spaced, the last
 * to arrive the first to go. Whoever is left when the fall ends, or every
 * user when there is no fall, is stopped at once. A user whose moment passed
 * while the generator was busy starts at once, so the ramp still ends on
 * time. When `interrupt` aborts first, no more users start and the ones
 * running are stopped at once. The phases are the ones that ran: the
 * stretch it was in ends when it was told to stop, and any later stretch
 * before the stop is empty. The ramp-down is the fall and the stop after it.
 * Users that are still mid-request after `stopWithinMs` are left behind.
 */
export async function runLoad(input: {
  plan: Plan;
  levels: Levels;
  requests: RequestLog;
  interrupt: AbortSignal;
  stopWithinMs?: number;
}) {
  const { plan, levels, requests, interrupt } = input;
  const gapMs = (plan.rampSeconds * 1_000) / Math.max(plan.userCount, 1);
  const users: Promise<void>[] = [];
  /** What lets each started user go, in the order they started. */
  const letGo: AbortController[] = [];

  const rampStartedMs = Date.now();
  const rampStartedAt = new Date(rampStartedMs).toISOString();
  for (let offset = 0; offset < plan.userCount && !interrupt.aborted; offset += 1) {
    const userNumber = plan.firstUser + offset;
    const user = new AbortController();
    letGo.push(user);
    users.push(
      runUser({
        plan,
        userNumber,
        levels,
        requests: requests.forUser(userNumber),
        signal: user.signal,
      }).catch(() => undefined),
    );
    const nextUserAt = rampStartedMs + (offset + 1) * gapMs;
    await pause(Math.max(0, nextUserAt - Date.now()) / 1_000, interrupt);
  }
  const holdStartedAt = new Date().toISOString();
  await pause(plan.holdSeconds, interrupt);
  const rampDownStartedAt = new Date().toISOString();
  await letGoOneByOne({ letGo, fallSeconds: plan.fallSeconds, interrupt });
  const interrupted = interrupt.aborted;
  for (const user of letGo) user.abort();
  await usersStopped(users, input.stopWithinMs ?? STOP_WITHIN_MS);
  return {
    interrupted,
    phases: {
      ramp: { startedAt: rampStartedAt, endedAt: holdStartedAt },
      hold: { startedAt: holdStartedAt, endedAt: rampDownStartedAt },
      rampDown: { startedAt: rampDownStartedAt, endedAt: new Date().toISOString() },
    },
  };
}

/**
 * Lets the users go over the fall, the last to start first, so that the
 * first leaves one gap after the fall begins and the last as it ends.
 * Returns at once when there is no fall, and as soon as `interrupt` aborts.
 */
async function letGoOneByOne(input: {
  letGo: readonly AbortController[];
  fallSeconds: number;
  interrupt: AbortSignal;
}) {
  const { letGo, fallSeconds, interrupt } = input;
  if (fallSeconds === 0 || interrupt.aborted) return;
  const fallStartedMs = Date.now();
  const gapMs = (fallSeconds * 1_000) / Math.max(letGo.length, 1);
  for (let left = letGo.length; left > 0 && !interrupt.aborted; left -= 1) {
    const goesAt = fallStartedMs + (letGo.length - left + 1) * gapMs;
    await pause(Math.max(0, goesAt - Date.now()) / 1_000, interrupt);
    if (!interrupt.aborted) letGo[left - 1]?.abort();
  }
}

async function usersStopped(users: readonly Promise<void>[], withinMs: number) {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, withinMs);
  });
  await Promise.race([Promise.all(users), late]);
  clearTimeout(timer);
}
