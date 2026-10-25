import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { existingRunId } from './runIds.ts';

function runsFolderWith(...runIds: string[]) {
  const folder = mkdtempSync(join(tmpdir(), 'runs-'));
  for (const runId of runIds) mkdirSync(join(folder, runId));
  return folder;
}

describe('existingRunId', () => {
  const runs = runsFolderWith(
    '20261020T090836Z-step10-load-direct',
    '20261020T101500Z-step10-load-direct',
    '20261021T020304Z-smoke-load',
    '20261021T020304Z-smoke-load-direct',
  );

  it('gives back a run id named in full', () => {
    expect(existingRunId(runs, '20261020T101500Z-step10-load-direct')).toBe(
      '20261020T101500Z-step10-load-direct',
    );
  });

  it('finds the one run whose id starts with the timestamp', () => {
    expect(existingRunId(runs, '20261020T090836Z')).toBe('20261020T090836Z-step10-load-direct');
  });

  it('prefers a run named in full over another run whose id it starts', () => {
    expect(existingRunId(runs, '20261021T020304Z-smoke-load')).toBe('20261021T020304Z-smoke-load');
  });

  it('says which runs match when several do', () => {
    expect(() => existingRunId(runs, '20261020')).toThrow(
      '"20261020" matches several runs: 20261020T090836Z-step10-load-direct, 20261020T101500Z-step10-load-direct. Name one in full.',
    );
  });

  it('says no run matches a name that matches nothing, rather than that a run is not sealed', () => {
    expect(() => existingRunId(runs, '20270101T000000Z')).toThrow(
      `No run matches "20270101T000000Z" in ${runs}`,
    );
  });

  it('matches nothing in a folder of runs that does not exist yet', () => {
    expect(() => existingRunId(join(runs, 'missing'), '2026')).toThrow(/No run matches "2026"/);
  });

  it('refuses an empty name, which would match every run', () => {
    expect(() => existingRunId(runs, '')).toThrow(/Name a run/);
  });

  it('matches folders only, not a file that happens to start with the name', () => {
    const folder = runsFolderWith('20261020T090836Z-step10-load-direct');
    writeFileSync(join(folder, '20261020T090836Z-notes.txt'), 'x');

    expect(existingRunId(folder, '20261020T090836Z')).toBe('20261020T090836Z-step10-load-direct');
  });
});
