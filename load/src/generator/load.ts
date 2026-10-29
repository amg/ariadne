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
 * Brings the plan's users up evenly over the ramp, holds them for the
 * hold, then stops them all. A user whose moment passed while the generator
 * was busy starts at once, so the ramp still ends on time. When
 * `interrupt` aborts first, no more users start and the ones running are
 * stopped at once. The phases are the ones
 * that ran: the stretch it was in ends when it was told to stop, and any
 * later stretch before the stop is empty. Users that are still mid-request
 * after `stopWithinMs` are left behind.
 */
export async function runLoad(input: {
  plan: Plan;
  levels: Levels;
  requests: RequestLog;
  interrupt: AbortSignal;
  stopWithinMs?: number;
}) {
  const { plan, levels, requests, interrupt } = input;
  const stop = new AbortController();
  const gapMs = (plan.rampSeconds * 1_000) / Math.max(plan.userCount, 1);
  const users: Promise<void>[] = [];

  const rampStartedMs = Date.now();
  const rampStartedAt = new Date(rampStartedMs).toISOString();
  for (let offset = 0; offset < plan.userCount && !interrupt.aborted; offset += 1) {
    const userNumber = plan.firstUser + offset;
    users.push(
      runUser(plan, userNumber, levels, requests.forUser(userNumber), stop.signal).catch(
        () => undefined,
      ),
    );
    const nextUserAt = rampStartedMs + (offset + 1) * gapMs;
    await pause(Math.max(0, nextUserAt - Date.now()) / 1_000, interrupt);
  }
  const holdStartedAt = new Date().toISOString();
  await pause(plan.holdSeconds, interrupt);
  const interrupted = interrupt.aborted;
  const rampDownStartedAt = new Date().toISOString();
  stop.abort();
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

async function usersStopped(users: readonly Promise<void>[], withinMs: number) {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, withinMs);
  });
  await Promise.race([Promise.all(users), late]);
  clearTimeout(timer);
}
