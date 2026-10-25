import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname } from 'node:path';

/** How long a stopped process gets to finish its work before it is killed, unless the caller gives it longer. */
const STOP_GRACE_MS = 15_000;

/**
 * Starts a process in a group of its own, with its output appended to
 * `logFile`. Stopping it signals the whole group, so a launcher such as
 * `tsx` cannot leave the program it launched behind.
 */
export function startProcess(input: {
  name: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  logFile: string;
  /** How long stopping it waits for it to end on its own before killing it. */
  graceMs?: number;
}) {
  mkdirSync(dirname(input.logFile), { recursive: true });
  const log = openSync(input.logFile, 'a');
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: ['ignore', log, log],
  });
  closeSync(log);

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group is already gone.
    }
  };

  return {
    name: input.name,
    groupId: child.pid,
    exited,
    async stop() {
      signalGroup('SIGTERM');
      const ended = await Promise.race([
        exited.then(() => true),
        sleep(input.graceMs ?? STOP_GRACE_MS).then(() => false),
      ]);
      if (!ended) signalGroup('SIGKILL');
      await exited;
      signalGroup('SIGKILL');
    },
  };
}

/** Whether something accepts connections on the port of this machine. */
export function portIsTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Polls `isReady` until it says yes. Gives up with an error when
 * `earlyExit` settles first, or when `timeoutMs` passes. When `signal`
 * aborts, it gives up at once with the signal's reason.
 */
export async function waitUntilReady(input: {
  what: string;
  isReady: () => Promise<boolean>;
  earlyExit: Promise<unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  let exitedEarly = false;
  input.earlyExit.then(() => {
    exitedEarly = true;
  });
  const deadline = Date.now() + input.timeoutMs;
  input.signal?.throwIfAborted();
  while (!(await input.isReady())) {
    input.signal?.throwIfAborted();
    if (exitedEarly) throw new Error(`${input.what} stopped before it was ready`);
    if (Date.now() > deadline) throw new Error(`${input.what} was not ready in time`);
    await sleep(500, input.signal);
    input.signal?.throwIfAborted();
  }
  input.signal?.throwIfAborted();
}

/** Waits the time given, or less when `signal` aborts first. */
export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
