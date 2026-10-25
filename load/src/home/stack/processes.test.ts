import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { portIsTaken, sleep, startProcess, waitUntilReady } from './processes.ts';

/** Running, not merely waiting to be reaped: a killed orphan stays a zombie until its new parent collects it. */
function isAlive(pid: number) {
  try {
    return !/^State:\s+[ZX]/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'));
  } catch {
    return false;
  }
}

/** A launcher that starts a long-lived program and reports its pid, as `tsx` does. */
const LAUNCHER = `
const { spawn } = require('node:child_process');
const program = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log('PROGRAM ' + program.pid);
setInterval(() => {}, 1000);
`;

async function programPidIn(logFile: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const match = readFileSync(logFile, 'utf8').match(/PROGRAM (\d+)/);
    if (match?.[1] !== undefined) return Number(match[1]);
    await sleep(100);
  }
  throw new Error('the launcher never reported its program');
}

describe('startProcess', () => {
  it('writes the process output to its log file', async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), 'home-')), 'out.log');
    const process = startProcess({
      name: 'echo',
      command: 'node',
      args: ['-e', 'console.log("hello")'],
      cwd: '.',
      env: { PATH: globalThis.process.env.PATH },
      logFile,
    });

    expect(await process.exited).toBe(0);
    expect(readFileSync(logFile, 'utf8')).toBe('hello\n');
  });

  it('stops the program a launcher started as well as the launcher', async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), 'home-')), 'out.log');
    const launcher = startProcess({
      name: 'launcher',
      command: 'node',
      args: ['-e', LAUNCHER],
      cwd: '.',
      env: { PATH: globalThis.process.env.PATH },
      logFile,
    });
    const programPid = await programPidIn(logFile);
    expect(isAlive(programPid)).toBe(true);

    await launcher.stop();

    expect(isAlive(programPid)).toBe(false);
  });
});

describe('waitUntilReady', () => {
  it('returns once ready', async () => {
    let calls = 0;
    await waitUntilReady({
      what: 'thing',
      isReady: async () => ++calls > 1,
      earlyExit: new Promise(() => {}),
      timeoutMs: 5_000,
    });

    expect(calls).toBe(2);
  });

  it('gives up with the reason at once when the signal aborts, without asking again', async () => {
    const stop = new AbortController();
    const reason = new Error('interrupted');
    let calls = 0;
    const waiting = waitUntilReady({
      what: 'thing',
      isReady: async () => {
        calls += 1;
        return false;
      },
      earlyExit: new Promise(() => {}),
      timeoutMs: 60_000,
      signal: stop.signal,
    });
    await sleep(50);
    stop.abort(reason);

    await expect(waiting).rejects.toBe(reason);
    expect(calls).toBe(1);
  });

  it('does not report ready when the signal aborted while it was being asked', async () => {
    const stop = new AbortController();

    await expect(
      waitUntilReady({
        what: 'thing',
        isReady: async () => {
          stop.abort(new Error('interrupted'));
          return true;
        },
        earlyExit: new Promise(() => {}),
        timeoutMs: 5_000,
        signal: stop.signal,
      }),
    ).rejects.toThrow('interrupted');
  });

  it('fails when the process ends first', async () => {
    await expect(
      waitUntilReady({
        what: 'the backend',
        isReady: async () => false,
        earlyExit: Promise.resolve(1),
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow('the backend stopped before it was ready');
  });
});

describe('portIsTaken', () => {
  it('is false for a port nothing listens on', async () => {
    expect(await portIsTaken(1)).toBe(false);
  });
});
