import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

const MAIN = new URL('./main.ts', import.meta.url).pathname;

/** The environment of a generator with no users: it has nothing to call, and starts nothing it could not stop. */
const environment = (holdSeconds: number): NodeJS.ProcessEnv => ({
  ...process.env,
  RUN_ID: 'run-1',
  TARGET_URL: 'http://127.0.0.1:1',
  LOAD_KEY_HEADER: 'x-load-key',
  LOAD_KEY: 'key',
  USER_PASSWORD: 'secret',
  EMAIL_DOMAIN: 'load.invalid',
  MODE: 'load',
  USER_COUNT: '0',
  RAMP_SECONDS: '0',
  HOLD_SECONDS: String(holdSeconds),
  STATE_SECONDS: '1',
});

type Ended = { code: number | null; printed: string; endedAfterMs: number };

/** Runs a generator to its end, sending `signal` after `afterMs` when one is given. */
function generatorRun(
  holdSeconds: number,
  stop: { signal: NodeJS.Signals; afterMs: number } | null,
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<Ended> {
  const started = performance.now();
  const child: ChildProcess = spawn(process.execPath, [MAIN], {
    env: { ...environment(holdSeconds), ...extraEnvironment },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let printed = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (piece: string) => {
    printed += piece;
  });
  if (stop !== null) setTimeout(() => child.kill(stop.signal), stop.afterMs);
  return new Promise((resolve) => {
    child.on('close', (code) =>
      resolve({ code, printed, endedAfterMs: performance.now() - started }),
    );
  });
}

const reportOf = (printed: string) => {
  const line = printed.split('\n').find((candidate) => candidate.startsWith('REPORT '));
  if (line === undefined) throw new Error(`no REPORT line in:\n${printed}`);
  return JSON.parse(line.slice('REPORT '.length));
};

describe('a generator process', () => {
  it('exits with its report written when its plan runs its course', async () => {
    const ended = await generatorRun(1, null);

    expect(ended.code).toBe(0);
    expect(reportOf(ended.printed)).toMatchObject({ interrupted: false });
  }, 30_000);

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'exits at once with its report, marked interrupted and holding the phases it ran, when told to stop with %s',
    async (signal) => {
      const ended = await generatorRun(120, { signal, afterMs: 1_500 });

      expect(ended.code).toBe(0);
      expect(ended.endedAfterMs).toBeLessThan(15_000);
      const report = reportOf(ended.printed);
      expect(report).toMatchObject({ interrupted: true });
      expect(report.phases).not.toBeNull();
    },
    30_000,
  );

  it('on the direct path, begins its plan at once, asking the origin nothing first', async () => {
    const asked: string[] = [];
    const origin = createServer((request, response) => {
      asked.push(request.url ?? '');
      response.end();
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const { port } = origin.address() as AddressInfo;

    const ended = await generatorRun(1, null, {
      TARGET_URL: `http://origin.invalid:${port}`,
      ORIGIN_ADDRESS: '127.0.0.1',
      ORIGIN_CLIENT_CERTIFICATE: 'certificate',
      ORIGIN_CLIENT_KEY: 'key',
    }).finally(() => origin.close());

    expect(ended.code).toBe(0);
    expect(ended.endedAfterMs).toBeLessThan(15_000);
    expect(reportOf(ended.printed)).toMatchObject({ interrupted: false });
    expect(asked).toEqual([]);
  }, 30_000);
});

describe('the generator’s sources', () => {
  it('read no file at run time, because the image is built without the files its build context leaves out', () => {
    const sources = readdirSync(new URL('.', import.meta.url).pathname).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );

    const readers = sources.filter((name) =>
      /node:fs|readFileSync|readFile\(/.test(
        readFileSync(new URL(name, import.meta.url).pathname, 'utf8'),
      ),
    );

    expect(readers).toEqual([]);
  });
});
