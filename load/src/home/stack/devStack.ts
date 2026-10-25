import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LAYOUT } from '../../records/index.ts';
import type { Inference } from '../options.ts';
import type { DevConnections, Environment, ManagedProcess } from '../types.ts';
import { backendEnvironment, mockEnvironment } from './environments.ts';
import { portIsTaken, startProcess, waitUntilReady } from './processes.ts';

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const BACKEND_DIR = join(REPO_ROOT, 'backend');

/** The signals that end a run early: Ctrl-C, a plain kill, and a closed terminal. */
const ENDING_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** What the stack starts, and where each program answers. */
type Program = { args: readonly string[]; cwd: string; port: number };

type StackPrograms = {
  command: string;
  backend: Program;
  mock: Program;
  /** How long each program gets to answer before the run gives up. */
  startTimeoutMs: number;
};

const DEV_PROGRAMS: StackPrograms = {
  command: join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
  backend: { args: ['app/server.ts'], cwd: BACKEND_DIR, port: 3101 },
  mock: { args: ['mock/server.ts'], cwd: BACKEND_DIR, port: 4141 },
  startTimeoutMs: 90_000,
};

/** A run cut short by the operator, with the signal that did it. */
export class Interrupted extends Error {
  readonly signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals) {
    super(`Interrupted by ${signal}`);
    this.signal = signal;
  }
}

type DevStack = {
  /** Where the run's backend answers. */
  backendUrl: string;
  /** What the stack started, in the order it started it. */
  processes: readonly ManagedProcess[];
  /** Aborts when the run must end early: an interrupt, or the backend or mock stopping. */
  signal: AbortSignal;
};

/**
 * Runs `work` against a backend of its own, started on dev's database and
 * auth core, with the mock inference beside it unless the run asks for
 * real inference. Both write their output into `folder`, and both are
 * stopped when `work` ends, fails or is interrupted. The frontend is not
 * started.
 *
 * Refuses to start while dev's own backend answers: it runs the queue in
 * the same process and would take the run's jobs.
 */
export async function withDevStack<T>(
  input: {
    folder: string;
    connections: DevConnections;
    inference: Inference;
    /** The programs to start; the dev backend and the mock when not given. */
    programs?: StackPrograms;
  },
  work: (stack: DevStack) => Promise<T>,
): Promise<T> {
  const programs = input.programs ?? DEV_PROGRAMS;
  await refuseWhileDevBackendRuns(input.connections.hostBackendUrl);
  await refuseTakenPorts(
    input.inference === 'mock'
      ? [programs.backend.port, programs.mock.port]
      : [programs.backend.port],
  );
  mkdirSync(input.folder, { recursive: true });

  const started: ManagedProcess[] = [];
  const stop = new AbortController();
  let stoppingOnPurpose = false;
  const onSignal = (signal: NodeJS.Signals): void => stop.abort(new Interrupted(signal));
  for (const signal of ENDING_SIGNALS) process.on(signal, onSignal);

  const start = (name: string, program: Program, env: Environment) => {
    const managed = startProcess({
      name,
      command: programs.command,
      args: program.args,
      cwd: program.cwd,
      env,
      logFile: join(input.folder, LAYOUT.processLog(name)),
    });
    started.push(managed);
    managed.exited.then((code) => {
      if (stoppingOnPurpose) return;
      stop.abort(
        new Error(
          `The ${name} stopped during the run (exit ${code}); see ${LAYOUT.processLog(name)}`,
        ),
      );
    });
    return managed;
  };

  try {
    const mockUrl = `http://127.0.0.1:${programs.mock.port}/v1`;
    if (input.inference === 'mock') {
      const mock = start('mock', programs.mock, mockEnvironment(process.env, programs.mock.port));
      await waitUntilReady({
        what: 'The mock inference',
        isReady: () => portIsTaken(programs.mock.port),
        earlyExit: mock.exited,
        timeoutMs: programs.startTimeoutMs,
        signal: stop.signal,
      });
    }
    const backendUrl = `http://127.0.0.1:${programs.backend.port}`;
    const backend = start(
      'backend',
      programs.backend,
      backendEnvironment({
        base: process.env,
        connections: input.connections,
        inference: input.inference,
        port: programs.backend.port,
        mockUrl,
      }),
    );
    await waitUntilReady({
      what: 'The backend',
      isReady: () => answersHealth(backendUrl),
      earlyExit: backend.exited,
      timeoutMs: programs.startTimeoutMs,
      signal: stop.signal,
    });

    const result = await work({ backendUrl, processes: started, signal: stop.signal });
    if (stop.signal.aborted) throw stop.signal.reason;
    return result;
  } catch (error) {
    throw stop.signal.aborted ? stop.signal.reason : error;
  } finally {
    stoppingOnPurpose = true;
    await Promise.all([...started].reverse().map((managed) => managed.stop()));
    for (const signal of ENDING_SIGNALS) process.off(signal, onSignal);
  }
}

async function refuseWhileDevBackendRuns(hostBackendUrl: string) {
  if (!(await answersHealth(hostBackendUrl))) return;
  throw new Error(
    `Dev's own backend is running at ${hostBackendUrl}. It runs the queue too and would take the run's jobs: stop it, then run again.`,
  );
}

async function refuseTakenPorts(ports: readonly number[]) {
  for (const port of ports) {
    if (await portIsTaken(port)) {
      throw new Error(
        `Port ${port} is already in use: an earlier run may have left a process behind.`,
      );
    }
  }
}

async function answersHealth(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/health`, {
    signal: AbortSignal.timeout(1_500),
  }).catch(() => null);
  await response?.body?.cancel();
  return response?.ok === true;
}
