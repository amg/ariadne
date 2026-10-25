import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LAYOUT } from '../records/index.ts';
import { writeWhole } from './files.ts';
import { runDescriptionSchema } from './manifestBuilder.ts';
import { expectedSourceSchema } from './selfChecks.ts';

const PENDING_RUN = `${LAYOUT.sourcesDir}/pending-run.json`;

/** What an archive needs to know of a run that is not in the run's own files. */
const pendingRunSchema = z.object({
  description: runDescriptionSchema,
  expected: z.array(expectedSourceSchema),
});
type PendingRun = z.infer<typeof pendingRunSchema>;

/**
 * Keeps what an archive needs beside the run, so that an archive that
 * failed can be run again. It lives among the unsorted sources and goes
 * with them when the run is sealed.
 */
export function savePendingRun(folder: string, pending: PendingRun) {
  writeWhole(join(folder, PENDING_RUN), JSON.stringify(pendingRunSchema.parse(pending), null, 2));
}

/** The pending run kept in `folder`; null when there is none, as with a run already sealed. */
export function readPendingRun(folder: string) {
  const file = join(folder, PENDING_RUN);
  if (!existsSync(file)) return null;
  return pendingRunSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
