import { taskIdOf } from './ecsLauncher.ts';
import type { EcsPort } from './ecsPort.ts';
import { messageOf } from './messageOf.ts';

/** How long the tasks that were told to stop are given to be stopped. */
const MOST_WAIT_MS = 5 * 60_000;

type Waiting = {
  ecs: EcsPort;
  pollEveryMs: number;
  sleep: (milliseconds: number) => Promise<void>;
};

/**
 * Stops every task still running in the generators' cluster, whoever started
 * it, and resolves once ECS says each has stopped. A task left running would
 * go on loading the app after its run is sealed.
 *
 * Tries every task, and rejects naming each that could not be stopped, or
 * that was still running after the wait.
 */
export async function stopEveryGenerator(
  input: Waiting & {
    /** Why the tasks are stopped, as ECS keeps it with each task. */
    reason: string;
  },
) {
  const running = await input.ecs.runningTaskArns();
  const couldNotStop: string[] = [];
  const asked: string[] = [];
  await Promise.all(
    running.map((arn) =>
      input.ecs.stopTask(arn, input.reason).then(
        () => {
          asked.push(arn);
        },
        (error: unknown) => {
          couldNotStop.push(`${taskIdOf(arn)} could not be stopped (${messageOf(error)})`);
        },
      ),
    ),
  );
  const stillRunning = (await tasksNotStoppedAfterTheWait(input, asked)).map(
    (arn) => `${taskIdOf(arn)} was still running after the wait`,
  );
  const problems = [...couldNotStop, ...stillRunning];
  if (problems.length > 0)
    throw new Error(`Not every generator was stopped: ${problems.join('; ')}`);
}

/** The tasks, of those asked about, that have not stopped when the wait is over. */
async function tasksNotStoppedAfterTheWait(input: Waiting, arns: readonly string[]) {
  let notStopped = arns;
  for (let waited = 0; notStopped.length > 0; waited += input.pollEveryMs) {
    const described = await input.ecs.describeTasks(notStopped);
    // A task ECS no longer knows has stopped.
    notStopped = notStopped.filter((arn) => described.get(arn)?.stopped === false);
    if (notStopped.length === 0 || waited >= MOST_WAIT_MS) break;
    await input.sleep(input.pollEveryMs);
  }
  return [...notStopped];
}
