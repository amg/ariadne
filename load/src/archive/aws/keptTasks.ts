import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LAYOUT } from '../../records/index.ts';
import type { TaskInfo } from '../../types/archive.ts';
import { writeWhole } from '../files.ts';

const KEPT_TASKS = `${LAYOUT.sourcesDir}/generator-tasks.jsonl`;

const taskInfoSchema = z.object({
  taskId: z.string(),
  cluster: z.string(),
  createdAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  stoppingAt: z.string().nullable().default(null),
  stoppedAt: z.string().nullable(),
  stopCode: z.string().nullable(),
  stoppedReason: z.string().nullable(),
  exitCode: z.number().nullable(),
  capacityProvider: z.string().nullable(),
  environment: z.record(z.string(), z.string()),
}) satisfies z.ZodType<TaskInfo>;

/**
 * Keeps each generator task that has stopped, as ECS described it, so that
 * the archive can still read it after ECS no longer does.
 */
export function generatorTaskKeeper(folder: string): {
  keep: (task: TaskInfo) => Promise<void>;
} {
  return {
    async keep(task) {
      const file = join(folder, KEPT_TASKS);
      const held = existsSync(file) ? readFileSync(file, 'utf8') : '';
      writeWhole(file, `${held}${JSON.stringify(taskInfoSchema.parse(task))}\n`);
    },
  };
}

/** The tasks kept in a run's folder; none when no generator has stopped yet. */
export function keptGeneratorTasks(folder: string): readonly TaskInfo[] {
  const file = join(folder, KEPT_TASKS);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => taskInfoSchema.parse(JSON.parse(line)));
}

/** The tasks ECS still describes, and the kept ones it has forgotten. */
export function withKeptTasks(
  live: readonly TaskInfo[],
  kept: readonly TaskInfo[],
): readonly TaskInfo[] {
  const known = new Set(live.map((task) => task.taskId));
  return [...live, ...kept.filter((task) => !known.has(task.taskId))];
}
