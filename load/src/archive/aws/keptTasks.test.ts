import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskInfo } from '../../types/archive.ts';
import { generatorTaskKeeper, keptGeneratorTasks, withKeptTasks } from './keptTasks.ts';

const task = (taskId: string, overrides: Partial<TaskInfo> = {}) => ({
  taskId,
  cluster: 'load',
  createdAt: '2026-10-15T00:00:00.000Z',
  startedAt: '2026-10-15T00:00:30.000Z',
  stoppingAt: '2026-10-15T00:09:20.000Z',
  stoppedAt: '2026-10-15T00:10:00.000Z',
  stopCode: 'SpotInterruption',
  stoppedReason: 'Your Spot Task was interrupted.',
  exitCode: 0,
  capacityProvider: 'FARGATE_SPOT',
  environment: { RUN_ID: 'run-1', GENERATOR: '0', ATTEMPT: '1' },
  ...overrides,
});

describe('generatorTaskKeeper', () => {
  it('keeps each stopped task in the folder, so a later reading finds them', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'kept-'));
    const { keep } = generatorTaskKeeper(folder);

    await keep(task('t1'));
    await keep(task('t2', { stopCode: 'UserInitiated' }));

    expect(keptGeneratorTasks(folder).map((kept) => [kept.taskId, kept.stopCode])).toEqual([
      ['t1', 'SpotInterruption'],
      ['t2', 'UserInitiated'],
    ]);
  });

  it('reads nothing from a folder where no task was kept', () => {
    expect(keptGeneratorTasks(mkdtempSync(join(tmpdir(), 'kept-')))).toEqual([]);
  });
});

describe('withKeptTasks', () => {
  it('prefers what ECS says now, and adds the kept tasks it has forgotten', () => {
    const live = task('t1', { stopCode: 'EssentialContainerExited' });
    const kept = [task('t1'), task('t2')];

    expect(withKeptTasks({ live: [live], kept, runId: 'run-1' })).toEqual([live, task('t2')]);
  });

  it('leaves out tasks of other runs, such as the warm-up', () => {
    const warmUp = task('t0', { environment: { RUN_ID: 'run-1-warm-up', GENERATOR: '0' } });

    expect(withKeptTasks({ live: [warmUp, task('t1')], kept: [], runId: 'run-1' })).toEqual([
      task('t1'),
    ]);
  });
});
