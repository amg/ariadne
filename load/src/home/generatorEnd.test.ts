import { describe, expect, it } from 'vitest';
import type { Report } from '../records/index.ts';
import { generatorEnd } from './generatorRun.ts';

const report = (overrides: Partial<Report> = {}) => ({
  runId: 'run-1',
  generator: 1,
  attempt: 1,
  startedAt: '2026-10-17T00:00:00.000Z',
  endedAt: '2026-10-17T00:01:00.000Z',
  interrupted: false,
  requests: { total: 0, byKind: {} },
  phases: null,
  ...overrides,
});

const printed = (value: Report) => `STATE {}\nREPORT ${JSON.stringify(value)}\n`;
const end = (input: { exitCode: number | null; timedOut?: boolean; output: string }) =>
  generatorEnd({ timedOut: false, outputName: 'out.log', ...input });

describe('generatorEnd', () => {
  it('finished when it exited cleanly with its report', () => {
    const finished = report();

    expect(end({ exitCode: 0, output: printed(finished) })).toEqual({
      how: 'finished',
      report: finished,
    });
  });

  it('stopped as interrupted when it was told to stop, though it exited cleanly', () => {
    const interrupted = report({ interrupted: true });

    expect(end({ exitCode: 0, output: printed(interrupted) })).toMatchObject({
      how: 'stopped',
      reason: 'interrupted',
      report: interrupted,
    });
  });

  it('failed, with no report, when a signal ended it before it could write one', () => {
    expect(end({ exitCode: null, output: 'STATE {}\n' })).toMatchObject({
      how: 'stopped',
      reason: 'failed',
      detail: expect.stringContaining('signal'),
      report: null,
    });
  });

  it('failed when it exited with an error, or cleanly with nothing to report', () => {
    expect(end({ exitCode: 1, output: '' })).toMatchObject({
      reason: 'failed',
      detail: expect.stringContaining('exit code 1'),
    });
    expect(end({ exitCode: 0, output: '' })).toMatchObject({
      reason: 'failed',
      detail: expect.stringContaining('without a report'),
    });
  });

  it('failed when the report it printed is not one', () => {
    expect(end({ exitCode: 0, output: 'REPORT {"runId":"run-1"}\n' })).toMatchObject({
      reason: 'failed',
      detail: expect.stringContaining('not valid'),
      report: null,
    });
  });

  it('timed out when it outlasted its time, whatever else it printed', () => {
    expect(
      end({ exitCode: 0, timedOut: true, output: printed(report({ interrupted: true })) }),
    ).toMatchObject({
      reason: 'timed-out',
    });
  });

  it('names the output to look in', () => {
    expect(end({ exitCode: 1, output: '' })).toMatchObject({
      detail: expect.stringContaining('see out.log'),
    });
  });
});
