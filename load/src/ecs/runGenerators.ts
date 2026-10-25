import { GeneratorDidNotFinish, sliceUsers, superviseStage } from '../run/index.ts';
import type { TaskInfo } from '../types/archive.ts';
import type { Supervision } from '../types/run.ts';
import { type GeneratorMode, ecsLauncher } from './ecsLauncher.ts';
import type { EcsPort, Placement } from './ecsPort.ts';
import { Interrupted } from './interruption.ts';
import { messageOf } from './messageOf.ts';

/**
 * The longest seeding may take, in seconds. A seeding generator has no ramp
 * and hold of its own, so this is how long it is given before it is stopped.
 */
const SEEDING_MOST_SECONDS = 60 * 60;

type GeneratorRun = {
  ecs: EcsPort;
  runId: string;
  /** A load run holds its users and replaces a lost generator; a seeding run creates the accounts and replaces none. */
  mode: GeneratorMode;
  placement: Placement;
  users: number;
  generators: number;
  rampSeconds: number;
  holdSeconds: number;
  thinkSeconds: number;
  /** Aborts when the run must end, which stops every generator. */
  signal: AbortSignal;
  keepStoppedTask: (task: TaskInfo) => Promise<void>;
  say: (line: string) => void;
  pollEveryMs: number;
  /** Waits for the milliseconds, for asking ECS again and for trying a launch again. */
  sleep: (milliseconds: number) => Promise<void>;
  /** The time in milliseconds; the clock unless a test says otherwise. */
  now?: () => number;
};

/**
 * Runs a run's generators in ECS to the end of the plan and watches them.
 * In a load run, a generator that stops early, such as one Spot took back or
 * one stopped by hand, is started again on the same slice of users, to end
 * with the run. When it cannot be started, its slice stays down and is
 * named. In a seeding run, a generator that stops early ends the run.
 * Resolves once every slice has run to the end. Otherwise rejects with what
 * ended the run, after stopping every generator still running.
 */
export async function runGenerators(run: GeneratorRun): Promise<void> {
  const launcher = ecsLauncher({
    ecs: run.ecs,
    runId: run.runId,
    mode: run.mode,
    placement: run.placement,
    keepStoppedTask: run.keepStoppedTask,
    warn: (line) => run.say(`Warning: ${line}`),
    pollEveryMs: run.pollEveryMs,
    sleep: run.sleep,
  });
  const seeding = run.mode === 'seed';
  await superviseStage({
    launcher,
    signal: run.signal,
    // ECS holds each launch and stop as the run's events: the archive reads them from its tasks.
    record: () => undefined,
    say: run.say,
    sleep: run.sleep,
    ...(run.now === undefined ? {} : { now: run.now }),
    stopReasonOf: stopReasonOfCause,
    replacesLostGenerators: !seeding,
    slices: sliceUsers({ users: run.users, generators: run.generators }),
    rampSeconds: seeding ? 0 : run.rampSeconds,
    holdSeconds: seeding ? SEEDING_MOST_SECONDS : run.holdSeconds,
    thinkSeconds: run.thinkSeconds,
  });
}

/** Why a generator stopped because the run ended, from what ended it. */
const stopReasonOfCause: Supervision['stopReasonOf'] = (cause) => {
  const detail = messageOf(cause);
  if (cause instanceof Interrupted) return { reason: 'interrupted', detail };
  if (cause instanceof GeneratorDidNotFinish) return { reason: cause.reason, detail };
  return { reason: 'failed', detail };
};
