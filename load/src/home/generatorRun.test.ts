import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { outOfTheWay, reportIn, runGenerator, threadForGenerator } from './generatorRun.ts';

const report = {
  runId: 'run-1',
  generator: 0,
  attempt: 1,
  startedAt: '2026-10-15T00:00:00.000Z',
  endedAt: '2026-10-15T00:01:00.000Z',
  interrupted: false,
  requests: { total: 0, byKind: {} },
  phases: null,
};

describe('reportIn', () => {
  it('reads the report the generator printed last', () => {
    const output = `STATE {}\nREPORT ${JSON.stringify(report)}\n`;

    expect(reportIn(output)).toEqual(report);
  });

  it('is null when the generator never reached its report', () => {
    expect(reportIn('STATE {}\nTypeError: boom\n')).toBeNull();
  });

  it('refuses a report that does not match its schema', () => {
    expect(() => reportIn('REPORT {"runId":"run-1"}\n')).toThrow();
  });
});

describe('outOfTheWay', () => {
  it('runs the command niced and pinned to one CPU thread', () => {
    expect(outOfTheWay('node', ['main.ts'], 7)).toEqual({
      command: 'nice',
      args: ['-n', '10', 'taskset', '-c', '7', 'node', 'main.ts'],
    });
  });

  it('only nices the command where there is nothing to pin with', () => {
    expect(outOfTheWay('node', ['main.ts'], null).args).toEqual(['-n', '10', 'node', 'main.ts']);
  });
});

describe('runGenerator', () => {
  it('starts nothing for a run the guard has already stopped', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'stopped-'));
    const stop = new AbortController();
    const reason = new Error('stopped by the guard');
    stop.abort(reason);

    await expect(
      runGenerator({ env: {}, folder, timeoutMs: 1_000, signal: stop.signal }),
    ).rejects.toBe(reason);
    expect(existsSync(join(folder, 'generator.log'))).toBe(false);
  });
});

describe('threadForGenerator', () => {
  it('spreads generators over the last two threads, counting back from the last', () => {
    expect([0, 1, 2, 3].map((generator) => threadForGenerator(generator, 8))).toEqual([7, 6, 7, 6]);
  });

  it('uses the only thread of a machine that has one', () => {
    expect([0, 1, 2].map((generator) => threadForGenerator(generator, 1))).toEqual([0, 0, 0]);
  });
});
