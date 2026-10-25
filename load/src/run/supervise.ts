import { type Report, type StopReason, formattedUserRange } from '../records/index.ts';
import type { GeneratorEnd, LaunchedGenerator, Supervision } from '../types/run.ts';
import { GeneratorDidNotFinish, TaskMayStillRun } from './launcher.ts';
import { replacementPlan } from './replacement.ts';
import type { sliceUsers } from './slices.ts';

type RampAndHold = NonNullable<ReturnType<typeof replacementPlan>>;

type Slice = ReturnType<typeof sliceUsers>[number];

/** How many times a slice's generator may stop before the run gives up on it. */
const MOST_STOPS = 4;

/** How long a replacement that cannot be launched is tried again before its slice is left down. */
const REPLACEMENT_LAUNCH_RETRY_MS = 3 * 60_000;

/** The wait between one try at launching a replacement and the next. */
const REPLACEMENT_LAUNCH_RETRY_EVERY_MS = 10_000;

/** How long a generator may outlast its plan before it is stopped. */
const GRACE_SECONDS = 120;
/** What one slice's supervision works with. */
type SliceRun = Supervision & {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  slice: Slice;
  thinkSeconds: number;
  /** When the stage is due to end; set once its first generator has been launched. */
  stage: { endsAt: number | null };
  /** Aborts when the run ends, or when another slice could not be kept running. */
  stageSignal: AbortSignal;
};

/**
 * Runs one stage: a generator for each slice, all at once, and watches
 * them. The stage ends when the plan of the first generator launched does.
 * A generator that stops before the stage's end is replaced on the same
 * slice, which brings its users back over about a minute and holds until
 * the stage's end. A replacement that cannot be launched is tried again
 * for a while, and then its slice is left down for the rest of the stage.
 * Every start and every stop, with its reason, is recorded.
 *
 * Resolves with the reports of the generators that wrote one. Rejects with
 * what ended the run when `signal` aborts, and with `GeneratorDidNotFinish`
 * when a slice cannot be kept running; the other generators are stopped
 * first. A stage that does not replace lost generators fails in the same
 * way as soon as one stops early.
 */
export async function superviseStage(
  input: Supervision & {
    slices: readonly Slice[];
    rampSeconds: number;
    holdSeconds: number;
    thinkSeconds: number;
  },
): Promise<Report[]> {
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const firstPlan = { rampSeconds: input.rampSeconds, holdSeconds: input.holdSeconds };
  const stage: { endsAt: number | null } = { endsAt: null };
  const failure = new AbortController();
  const stageSignal = AbortSignal.any([input.signal, failure.signal]);
  const results = await Promise.allSettled(
    input.slices.map((slice) =>
      superviseSlice({ ...input, now, sleep, slice, stage, stageSignal }, firstPlan).catch(
        (error: unknown) => {
          failure.abort(error);
          throw error;
        },
      ),
    ),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
  return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

/** Keeps one slice's generator running to the stage's end, and returns the reports of every attempt that wrote one. */
async function superviseSlice(run: SliceRun, firstPlan: RampAndHold): Promise<Report[]> {
  const reports: Report[] = [];
  let attempt = 1;
  let stops = 0;
  run.stageSignal.throwIfAborted();
  let generator = await startFirstGenerator(run, firstPlan);
  for (;;) {
    const end = await endOrAbort(generator, run.stageSignal);
    if (end === 'aborted') return stopForRunEnd(run, attempt, generator);
    if (end.report !== null) reports.push(end.report);
    stops += 1;
    const stop: Stop = { attempt, at: instantOf(run.now()), ...stopOf(end) };
    const next = nextStepAfter(end, {
      generator: run.slice.generator,
      stops,
      left: secondsLeft(run),
      replaces: run.replacesLostGenerators ?? true,
    });
    sayAfterStop(run, attempt, end, next);
    if (next.kind === 'give-up') {
      recordStop(run, stop, null);
      throw next.error;
    }
    if (next.kind !== 'replace') {
      recordStop(run, stop, null);
      return reports;
    }
    const replacement = await startReplacement(run, attempt + 1).catch((error: unknown) => {
      recordStop(run, stop, null);
      throw error;
    });
    if (replacement.kind === 'not-started') {
      recordStop(run, withReplacementFailure(stop, replacement.reason), null);
      run.say(
        `Generator ${run.slice.generator} stays down for the rest of the stage: users ${formattedUserRange(run.slice)} have no generator (${replacement.reason})`,
      );
      return reports;
    }
    recordStop(run, stop, replacement.attempt);
    attempt = replacement.attempt;
    generator = replacement.generator;
  }
}

/** The stop with what kept its slice from being replaced added to why it stopped. */
function withReplacementFailure(stop: Stop, reason: string): Stop {
  const gap = `it could not be replaced: ${reason}`;
  return { ...stop, detail: stop.detail === null ? gap : `${stop.detail}; ${gap}` };
}

/** Starts a slice's first generator. A generator that cannot be started ends its slice, and with it the stage. */
async function startFirstGenerator(run: SliceRun, plan: RampAndHold) {
  try {
    return await launchAttempt(run, 1, plan, null);
  } catch (error) {
    if (run.stageSignal.aborted) throw run.stageSignal.reason;
    throw new GeneratorDidNotFinish(
      'failed',
      `Generator ${run.slice.generator} attempt 1 could not be started: ${reasonOf(error)}`,
    );
  }
}

/** A replacement that is up, or the reason it could not be got up in time. */
type Replacement =
  | { kind: 'started'; attempt: number; generator: LaunchedGenerator }
  | { kind: 'not-started'; reason: string };

/**
 * Starts a replacement for a slice, which ends with the stage. A launch
 * that fails is tried again, under a new attempt number, until it has been
 * tried for a while or too little of the stage is left. It is not tried
 * again when the failed launch left a task that could not be stopped.
 * Throws what ended the run when that happens meanwhile.
 */
async function startReplacement(run: SliceRun, firstAttempt: number): Promise<Replacement> {
  const giveUpAt = run.now() + REPLACEMENT_LAUNCH_RETRY_MS;
  let reason = '';
  for (let attempt = firstAttempt; ; attempt += 1) {
    run.stageSignal.throwIfAborted();
    const plan = replacementPlan(secondsLeft(run));
    if (plan === null)
      return { kind: 'not-started', reason: reason || 'too little of the stage was left' };
    try {
      const generator = await launchAttempt(run, attempt, plan, run.stage.endsAt);
      return { kind: 'started', attempt, generator };
    } catch (error) {
      if (run.stageSignal.aborted) throw run.stageSignal.reason;
      reason = reasonOf(error);
      if (error instanceof TaskMayStillRun) return { kind: 'not-started', reason };
    }
    if (run.now() >= giveUpAt) return { kind: 'not-started', reason };
    run.say(
      `Generator ${run.slice.generator} attempt ${attempt} could not be started (${reason}); trying again in ${REPLACEMENT_LAUNCH_RETRY_EVERY_MS / 1_000} s`,
    );
    await pauseUnlessAborted(run.sleep, REPLACEMENT_LAUNCH_RETRY_EVERY_MS, run.stageSignal);
  }
}

/**
 * Starts one generator and records it. A generator given `endsAt` ends
 * then, however long its start took.
 */
async function launchAttempt(
  run: SliceRun,
  attempt: number,
  plan: RampAndHold,
  endsAt: number | null,
) {
  const { slice } = run;
  const generator = await run.launcher.launch(
    {
      generator: slice.generator,
      attempt,
      firstUser: slice.firstUser,
      userCount: slice.userCount,
      rampSeconds: plan.rampSeconds,
      holdSeconds: plan.holdSeconds,
      endsAt,
      thinkSeconds: run.thinkSeconds,
      timeoutMs: (plan.rampSeconds + plan.holdSeconds + GRACE_SECONDS) * 1_000,
    },
    run.stageSignal,
  );
  // A launch can take a while, so the first plan counts from when it has finished.
  const launchedAt = run.now();
  run.stage.endsAt ??= launchedAt + (plan.rampSeconds + plan.holdSeconds) * 1_000;
  const holdEndsAt = endsAt ?? launchedAt + (plan.rampSeconds + plan.holdSeconds) * 1_000;
  run.record({
    kind: 'generator-launched',
    at: instantOf(launchedAt),
    generator: slice.generator,
    attempt,
    firstUser: slice.firstUser,
    userCount: slice.userCount,
    task: generator.task,
    spot: generator.spot,
    planned: {
      rampEndsAt: instantOf(Math.min(launchedAt + plan.rampSeconds * 1_000, holdEndsAt)),
      holdEndsAt: instantOf(holdEndsAt),
    },
  });
  run.say(
    `Generator ${slice.generator} attempt ${attempt} started (${generator.task}) for users ${formattedUserRange(slice)}`,
  );
  return generator;
}

/** Stops a generator because the run is ending, records why, and ends the slice with what ended the run. */
async function stopForRunEnd(
  run: SliceRun,
  attempt: number,
  generator: LaunchedGenerator,
): Promise<never> {
  await generator.stop();
  const why = run.signal.aborted
    ? run.stopReasonOf(run.signal.reason)
    : { reason: 'interrupted' as const, detail: 'another generator could not be kept running' };
  recordStop(run, { attempt, ...why, stoppedForRunEnd: true }, null);
  throw run.stageSignal.reason;
}

/** What a generator's end means for its slice. */
type NextStep =
  | { kind: 'done' }
  | { kind: 'replace'; plan: RampAndHold }
  | { kind: 'leave-down'; why: string }
  | { kind: 'give-up'; error: GeneratorDidNotFinish };

/**
 * What to do with a slice whose generator has ended: nothing when it
 * finished; give up when it outlasted its time, when it stopped early and
 * lost generators are not replaced, or when it has stopped too many
 * times; leave the slice down when the generator may still be running, so
 * that two never load one slice; otherwise replace it, unless too little of
 * the stage is left to bring its users back.
 */
function nextStepAfter(
  end: GeneratorEnd,
  context: { generator: number; stops: number; left: number; replaces: boolean },
): NextStep {
  if (end.how === 'finished') return { kind: 'done' };
  if (end.reason === 'timed-out') {
    return { kind: 'give-up', error: new GeneratorDidNotFinish('timed-out', end.detail) };
  }
  if (!context.replaces) {
    return {
      kind: 'give-up',
      error: new GeneratorDidNotFinish(
        'failed',
        `Generator ${context.generator} stopped before it finished (${end.reason}: ${end.detail}), and this run does not replace a lost generator`,
      ),
    };
  }
  if (end.mayStillRun === true) {
    return {
      kind: 'leave-down',
      why: 'it could not be stopped, so a replacement might load its users twice',
    };
  }
  if (context.stops >= MOST_STOPS) {
    return {
      kind: 'give-up',
      error: new GeneratorDidNotFinish(
        'failed',
        `Generator ${context.generator} stopped ${context.stops} times; the last time: ${end.detail}`,
      ),
    };
  }
  const plan = replacementPlan(context.left);
  return plan === null
    ? { kind: 'leave-down', why: 'too little of the stage is left to bring its users back' }
    : { kind: 'replace', plan };
}

function stopOf(end: GeneratorEnd): { reason: StopReason; detail: string | null } {
  return end.how === 'finished'
    ? { reason: 'finished', detail: null }
    : { reason: end.reason, detail: end.detail };
}

/** How an attempt's generator stopped; `at` is when, if that was before now. */
type Stop = {
  attempt: number;
  at?: string;
  reason: StopReason;
  detail: string | null;
  stoppedForRunEnd?: boolean;
};

function recordStop(run: SliceRun, stop: Stop, replacedByAttempt: number | null) {
  const { attempt, at, reason, detail, stoppedForRunEnd = false } = stop;
  run.record({
    kind: 'generator-stopped',
    ...(at === undefined ? {} : { at }),
    generator: run.slice.generator,
    attempt,
    reason,
    detail,
    toldToStopAt: null,
    stoppedForRunEnd,
    replacedByAttempt,
  });
}

function sayAfterStop(run: SliceRun, attempt: number, end: GeneratorEnd, next: NextStep) {
  const { slice } = run;
  const users = formattedUserRange(slice);
  const stopped = `Generator ${slice.generator} attempt ${attempt} stopped`;
  if (next.kind === 'replace' && end.how === 'stopped') {
    run.say(
      `${stopped} (${end.reason}: ${end.detail}); bringing users ${users} back over ${next.plan.rampSeconds} s`,
    );
  }
  if (next.kind === 'leave-down') {
    run.say(`${stopped}, and users ${users} stay down: ${next.why}`);
  }
}

function secondsLeft(run: SliceRun) {
  return Math.max(0, ((run.stage.endsAt ?? run.now()) - run.now()) / 1_000);
}

function instantOf(milliseconds: number) {
  return new Date(milliseconds).toISOString();
}

/** Resolves with how the generator ended, or 'aborted' as soon as `signal` aborts. */
function endOrAbort(
  generator: LaunchedGenerator,
  signal: AbortSignal,
): Promise<GeneratorEnd | 'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve('aborted');
    const onAbort = (): void => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    generator.ended.then((end) => {
      signal.removeEventListener('abort', onAbort);
      resolve(end);
    });
  });
}

/** Resolves once the wait is over, or as soon as `signal` aborts. */
function pauseUnlessAborted(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    sleep(milliseconds).then(done);
  });
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
