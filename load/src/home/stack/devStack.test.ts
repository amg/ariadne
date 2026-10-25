import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT } from '../../records/index.ts';
import { Interrupted, withDevStack } from './devStack.ts';

type StackPrograms = NonNullable<Parameters<typeof withDevStack>[0]['programs']>;

import { sleep } from './processes.ts';

let server: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

/** Something answering the health route where dev's own backend would. */
async function devBackendAnsweringAt() {
  const listening = createServer((_request, response) => {
    response.end('{"status":"ok"}');
  });
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
  const address = listening.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('withDevStack', () => {
  it('refuses to start while dev’s own backend is answering, and starts nothing', async () => {
    const work = vi.fn();
    const connections = {
      databaseUrl: 'postgres://unused',
      authCoreUrl: 'http://unused',
      hostBackendUrl: await devBackendAnsweringAt(),
    };

    await expect(
      withDevStack({ folder: '/nonexistent/run', connections, inference: 'mock' }, work),
    ).rejects.toThrow(/Dev's own backend is running/);

    expect(work).not.toHaveBeenCalled();
  });
});

/**
 * A stand-in for the backend: it starts a program of its own and reports its
 * pid, as `tsx` does, then answers the health route unless told to stay silent.
 */
const STUB = `
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const program = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log('PROGRAM ' + program.pid);
if (process.argv[2] === 'silent') setInterval(() => {}, 1000);
else createServer((_request, response) => response.end('{}')).listen(Number(process.env.PORT), '127.0.0.1');
`;

/** Running, not merely waiting to be reaped: a killed orphan stays a zombie until its new parent collects it. */
function isAlive(pid: number) {
  try {
    return !/^State:\s+[ZX]/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'));
  } catch {
    return false;
  }
}

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

async function stubStack(behaviour: 'answers' | 'silent') {
  const folder = mkdtempSync(join(tmpdir(), 'stack-'));
  const script = join(folder, 'stub.cjs');
  writeFileSync(script, STUB);
  const programs: StackPrograms = {
    command: process.execPath,
    backend: { args: [script, behaviour], cwd: folder, port: await freePort() },
    mock: { args: [script, 'answers'], cwd: folder, port: await freePort() },
    startTimeoutMs: 60_000,
  };
  const connections = {
    databaseUrl: 'postgres://unused',
    authCoreUrl: 'http://unused',
    hostBackendUrl: 'http://127.0.0.1:1',
  };
  return { folder, programs, connections };
}

function readLogOrEmpty(file: string) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

async function programPidsIn(folder: string, names: readonly string[]) {
  const pids: number[] = [];
  for (const name of names) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const logged = readLogOrEmpty(join(folder, LAYOUT.processLog(name)));
      const match = logged.match(/PROGRAM (\d+)/);
      if (match?.[1] !== undefined) {
        pids.push(Number(match[1]));
        break;
      }
      await sleep(50);
    }
  }
  return pids;
}

describe('withDevStack, when the run ends early', () => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'leaves no process behind after %s in the middle of the run',
    async (signal) => {
      const { folder, programs, connections } = await stubStack('answers');
      let pids: number[] = [];

      const ended = withDevStack(
        { folder, connections, inference: 'mock', programs },
        async (stack) => {
          pids = await programPidsIn(folder, ['mock', 'backend']);
          process.emit(signal);
          await sleep(60_000, stack.signal);
        },
      );

      await expect(ended).rejects.toBeInstanceOf(Interrupted);
      expect(pids).toHaveLength(2);
      expect(pids.map(isAlive)).toEqual([false, false]);
    },
  );

  it('acts at once on a signal while the backend is still starting', async () => {
    const { folder, programs, connections } = await stubStack('silent');
    const work = vi.fn();

    const ended = withDevStack({ folder, connections, inference: 'mock', programs }, work);
    const [mockPid, backendPid] = await programPidsIn(folder, ['mock', 'backend']);
    const signalledAt = Date.now();
    process.emit('SIGHUP');

    await expect(ended).rejects.toBeInstanceOf(Interrupted);
    expect(Date.now() - signalledAt).toBeLessThan(5_000);
    expect(work).not.toHaveBeenCalled();
    expect([mockPid, backendPid].map((pid) => isAlive(pid ?? 0))).toEqual([false, false]);
  });

  it('stops listening for signals once the run is over', async () => {
    const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => process.listenerCount(name));
    const { folder, programs, connections } = await stubStack('answers');

    await withDevStack({ folder, connections, inference: 'real', programs }, async () => 'done');

    expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => process.listenerCount(name))).toEqual(
      before,
    );
  });
});
