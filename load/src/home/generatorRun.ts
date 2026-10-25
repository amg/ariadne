import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { type Report, reportSchema } from '../records/index.ts';
import { GeneratorDidNotFinish } from '../run/index.ts';
import type { EarlyStop, GeneratorEnd } from '../types/run.ts';
import { startProcess } from './stack/index.ts';
import type { Environment, ManagedProcess } from './types.ts';

const LOAD_DIR = new URL('../../', import.meta.url).pathname;

/** How far the generator is niced: well behind the backend and everything else on the machine. */
const GENERATOR_NICENESS = 10;

/** The report a generator printed as its last act, or null when its output holds none. */
export function reportIn(generatorOutput: string) {
  const line = lastLineOf(generatorOutput, 'REPORT');
  return line === null ? null : reportSchema.parse(JSON.parse(line));
}

/**
 * A command run at low priority, and held to one CPU thread when
 * `cpuToPinTo` is given. A generator is one Node process, so one thread is
 * all it can use anyway; pinning it keeps it from spreading over the
 * cores the backend and the rest of the machine need.
 */
export function outOfTheWay(command: string, args: readonly string[], cpuToPinTo: number | null) {
  const pin = cpuToPinTo === null ? [] : ['taskset', '-c', String(cpuToPinTo)];
  return {
    command: 'nice',
    args: ['-n', String(GENERATOR_NICENESS), ...pin, command, ...args],
  };
}

/** How long a generator told to stop gets to write its report before it is killed. */
const GENERATOR_STOP_GRACE_MS = 30_000;

/** The most CPU threads the generators of a run share between them. */
const MOST_THREADS_FOR_GENERATORS = 2;

/** A generator process, and what it left once it ended. */
type RunningGenerator = {
  process: ManagedProcess;
  /** Settles once the generator and everything it started are gone. */
  ended: Promise<GeneratorEnd>;
};

/**
 * Starts a generator as a process of this machine, out of the way of its
 * other work and pinned to one CPU thread, with its output kept in
 * `outputFile`. The generator is stopped when it outlasts `timeoutMs`.
 * `outputName` is how the output file is named in what `ended` says.
 */
export function startGenerator(input: {
  name: string;
  /** Which generator of the run it is; generators spread over the threads set aside for them. */
  generator: number;
  env: Environment;
  outputFile: string;
  outputName: string;
  timeoutMs: number;
}): RunningGenerator {
  const command = outOfTheWay(
    process.execPath,
    ['src/generator/main.ts'],
    cpuToPinTo(input.generator),
  );
  const generator = startProcess({
    name: input.name,
    ...command,
    cwd: LOAD_DIR,
    env: input.env,
    logFile: input.outputFile,
    graceMs: GENERATOR_STOP_GRACE_MS,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void generator.stop();
  }, input.timeoutMs);
  const ended = generator.exited.then(async (exitCode) => {
    clearTimeout(timer);
    await generator.stop();
    return generatorEnd({
      exitCode,
      timedOut,
      output: readFileSync(input.outputFile, 'utf8'),
      outputName: input.outputName,
    });
  });
  return { process: generator, ended };
}

/**
 * Runs one generator to its end and returns its report. The generator's
 * output goes to `logName`, a path in the run's folder. It is stopped, and
 * the run fails, when `signal` aborts or when it outlasts `timeoutMs`.
 * `onStarted` is called with the generator's process as soon as it exists.
 */
export async function runGenerator(input: {
  env: Environment;
  folder: string;
  timeoutMs: number;
  signal: AbortSignal;
  logName?: string;
  onStarted?: (generator: ManagedProcess) => void;
}): Promise<Report> {
  input.signal.throwIfAborted();
  const logName = input.logName ?? 'generator.log';
  const running = startGenerator({
    name: 'generator',
    generator: 0,
    env: input.env,
    outputFile: join(input.folder, logName),
    outputName: logName,
    timeoutMs: input.timeoutMs,
  });
  input.onStarted?.(running.process);
  const onAbort = (): void => {
    void running.process.stop();
  };
  input.signal.addEventListener('abort', onAbort);
  try {
    const end = await running.ended;
    if (input.signal.aborted) throw input.signal.reason;
    if (end.how === 'finished') {
      if (end.report !== null) return end.report;
      throw new GeneratorDidNotFinish('failed', 'The generator finished without a report');
    }
    throw new GeneratorDidNotFinish(
      end.reason === 'timed-out' ? 'timed-out' : 'failed',
      end.detail,
    );
  } finally {
    input.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * How a generator ended, from its exit code and what it printed. A
 * generator that was told to stop wrote a report marked as interrupted,
 * and counts as stopped even though it exited cleanly. One that was ended
 * without a chance to report, such as by a kill signal, counts as failed.
 */
export function generatorEnd(input: {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  outputName: string;
}): GeneratorEnd {
  const { exitCode, outputName } = input;
  const { report, problem } = printedReport(input.output);
  const stopped = (reason: EarlyStop, detail: string): GeneratorEnd => ({
    how: 'stopped',
    reason,
    detail: `${detail}; see ${outputName}`,
    report,
  });
  if (input.timedOut)
    return stopped('timed-out', 'The generator outlasted the run and was stopped');
  if (report?.interrupted) {
    return stopped('interrupted', 'The generator was told to stop, and wrote its report as it did');
  }
  if (problem !== null) return stopped('failed', problem);
  if (exitCode === null) {
    return stopped('failed', 'The generator was ended by a signal before it could report');
  }
  if (exitCode !== 0) return stopped('failed', `The generator ended with exit code ${exitCode}`);
  if (report === null) return stopped('failed', 'The generator ended without a report');
  return { how: 'finished', report };
}

/** The report in a generator's output, or null with what was wrong when the output holds one that is not valid. */
function printedReport(output: string): { report: Report | null; problem: string | null } {
  try {
    return { report: reportIn(output), problem: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { report: null, problem: `The generator's report is not valid (${reason})` };
  }
}

/**
 * The CPU thread a generator is pinned to: one of the last few threads of
 * this machine, so that generators share a small part of it. Null where
 * `taskset` is not there to pin with.
 */
function cpuToPinTo(generator: number) {
  const pinnable = ['/usr/bin/taskset', '/bin/taskset'].some((path) => existsSync(path));
  return pinnable ? threadForGenerator(generator, availableParallelism()) : null;
}

/** The thread of `threads` that a generator takes, counting back from the last. */
export function threadForGenerator(generator: number, threads: number) {
  const shared = Math.min(MOST_THREADS_FOR_GENERATORS, threads);
  return threads - 1 - (generator % shared);
}

function lastLineOf(output: string, kind: 'REPORT') {
  const line = output
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith(`${kind} `));
  return line === undefined ? null : line.slice(kind.length + 1);
}
