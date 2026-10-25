import {
  type ExpectedSource,
  type RunDescription,
  archiveLocalRun,
  currentCommit,
  savePendingRun,
} from '../archive/index.ts';
import { rebuildRun } from '../rebuild/index.ts';
import { type Finding, LAYOUT, type StopReason } from '../records/index.ts';
import { GeneratorDidNotFinish, sliceUsers, superviseStage } from '../run/index.ts';

import { localLauncher } from './localLauncher.ts';
import type { parseRunOptions } from './options.ts';
import { recordEvent } from './runFolder.ts';
import { Interrupted, withDevStack } from './stack/index.ts';
import type { DevConnections, ManagedProcess } from './types.ts';
import type { judgeHost } from './watch/guard.ts';
import { GuardTripped, startHouseWatch } from './watch/index.ts';

type LocalLauncher = ReturnType<typeof localLauncher>;

type RunOptions = ReturnType<typeof parseRunOptions>;

type Breach = NonNullable<ReturnType<typeof judgeHost>>;

type Rebuilt = ReturnType<typeof rebuildRun>;

/** The step every home run records. */
export const HOME_STEP = 'home-smoke';

/** How often the guard reads the host. */
const READING_EVERY_MS = 2_000;

type HomeRun = {
  options: RunOptions;
  runId: string;
  folder: string;
  startedAt: Date;
  password: string;
  glancesUrl: string;
  connections: DevConnections;
};

/**
 * Carries out a run: starts the stack, watches the house, and runs the
 * generators, replacing one that is lost, and records the run's events as
 * they happen.
 * It does not throw. Whatever ended the run early comes back as `failure`:
 * the guard, an interrupt, or a failure. It is null when the run finished.
 */
export async function carryOut(run: HomeRun): Promise<{ failure: unknown }> {
  const { options, folder } = run;
  let started: readonly ManagedProcess[] = [];
  try {
    await withDevStack(
      { folder, connections: run.connections, inference: options.inference },
      async (stack) => {
        started = stack.processes;
        recordEvent(folder, { kind: 'run-started', at: run.startedAt.toISOString() });
        for (const started of stack.processes) {
          recordEvent(folder, {
            kind: 'process-started',
            name: started.name,
            task: `pid-${started.groupId}`,
          });
        }
        const halt = new AbortController();
        const launcher = localLauncher({
          folder,
          runId: run.runId,
          backendUrl: stack.backendUrl,
          password: run.password,
          nameOf: (generator) =>
            options.generators === 1 ? 'generator' : `generator-${generator}`,
        });
        const watch = startHouseWatch({
          folder,
          lines: options.guard,
          glancesUrl: run.glancesUrl,
          intervalMs: READING_EVERY_MS,
          users: () => launcher.users(),
          onBreach: (breach) => halt.abort(new GuardTripped(breach)),
          onFailure: (error) => halt.abort(error),
        });
        const signal = AbortSignal.any([stack.signal, halt.signal]);

        let stoppedBy: Breach | null = null;
        try {
          await runGenerators({ run, signal, launcher });
        } finally {
          stoppedBy = await watch.stop();
          if (stoppedBy !== null) recordGuardTrip(folder, stoppedBy);
        }
        if (stoppedBy !== null) throw new GuardTripped(stoppedBy);
        if (halt.signal.aborted) throw halt.signal.reason;
      },
    );
    return { failure: null };
  } catch (error) {
    return { failure: error };
  } finally {
    for (const stopped of started) {
      recordEvent(folder, { kind: 'process-stopped', name: stopped.name });
    }
  }
}

async function runGenerators(input: {
  run: HomeRun;
  signal: AbortSignal;
  launcher: LocalLauncher;
}): Promise<void> {
  const { run } = input;
  const { options } = run;
  console.log(`${options.users} users, generators: ${options.generators}`);
  await superviseStage({
    launcher: input.launcher,
    signal: input.signal,
    record: (event) => recordEvent(run.folder, event),
    say: (line) => console.log(`  ${line}`),
    stopReasonOf: (cause) => ({
      reason: stopReasonOf(cause),
      detail: cause instanceof Error ? cause.message : String(cause),
    }),
    slices: sliceUsers({ users: options.users, generators: options.generators }),
    rampSeconds: options.rampSeconds,
    holdSeconds: options.holdSeconds,
    thinkSeconds: options.thinkSeconds,
  });
  const { succeeded } = input.launcher.users();
  console.log(`  ${succeeded.signin ?? 0} sign-ins, ${succeeded.chat ?? 0} replies streamed`);
}

function recordGuardTrip(folder: string, breach: Breach) {
  recordEvent(folder, {
    kind: 'guard-tripped',
    line: breach.line,
    observed: breach.observed,
    limit: breach.limit,
    message: breach.message,
  });
}

/** Why a generator stopped, from what ended its run. */
export function stopReasonOf(error: unknown): StopReason {
  if (error instanceof GuardTripped) return 'guard';
  if (error instanceof Interrupted) return 'interrupted';
  if (error instanceof GeneratorDidNotFinish) return error.reason;
  return 'failed';
}

/** How a run ended, from what ended it: null for a run that finished. */
export function outcomeOf(failure: unknown) {
  if (failure === null) return 'finished';
  if (failure instanceof GuardTripped) return 'guard';
  if (failure instanceof Interrupted) return 'interrupted';
  return 'failed';
}

/**
 * Ends a run that began: records how it ended, archives the folder into a
 * sealed run, and rebuilds the verdict from the folder alone. Nothing about
 * the verdict is kept from the run itself, so a later rebuild of the same
 * folder gives the same one.
 */
export async function finishRun(input: {
  run: HomeRun;
  failure: unknown;
}): Promise<{ incompleteBecause: readonly Finding[]; rebuilt: Rebuilt }> {
  const { run, failure } = input;
  recordEvent(run.folder, { kind: 'run-ended', outcome: outcomeOf(failure) });
  const description = describeRun(run, new Date());
  const expected = expectedSourcesOf(run.options);
  savePendingRun(run.folder, { description, expected });
  const archived = await archiveLocalRun({
    folder: run.folder,
    description,
    expected,
  });
  const { seal } = archived.manifest;
  return {
    incompleteBecause: seal.status === 'incomplete' ? seal.reasons : [],
    rebuilt: rebuildRun(run.folder),
  };
}

/** What the manifest of a run says about it, which no file of the run records by itself. */
function describeRun(run: HomeRun, endedAt: Date): RunDescription {
  const { options } = run;
  return {
    runId: run.runId,
    step: HOME_STEP,
    config: { ...options },
    target: 'cubi-dev',
    loadPath: 'direct',
    images: {},
    commits: { app: currentCommit(), harness: currentCommit() },
    limits: { ...options.guard },
    startedAt: run.startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    trailingEndsAt: null,
  };
}

/** The logs and metrics a home run must leave: the host, and the log of each process it started. */
export function expectedSourcesOf(options: Pick<RunOptions, 'inference'>): ExpectedSource[] {
  const processes = options.inference === 'mock' ? ['backend', 'mock'] : ['backend'];
  return [
    { service: 'host', kind: 'metrics', path: LAYOUT.hostSamples },
    ...processes.map(
      (name): ExpectedSource => ({ service: name, kind: 'logs', path: LAYOUT.processLog(name) }),
    ),
  ];
}
