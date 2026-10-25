import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { existingRunId } from '../records/index.ts';
import { rebuildRun } from './rebuildRun.ts';

const RUNS_DIR = new URL('../../.runs/', import.meta.url).pathname;

/**
 * Rebuilds a run from its folder alone, and writes what it derives under
 * `derived/` in that folder:
 *   npm run rebuild --workspace=load -- <run id or folder>
 *
 * A run id names a folder among the harness's local runs, in full or by the
 * start of it, such as its timestamp. The run is judged by the limits it
 * recorded when it began. Exits with 1 when the verdict is not a pass.
 */
function main(): number {
  const { positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
  });
  const [wanted] = positionals;
  if (wanted === undefined) throw new Error('usage: rebuild <run id or folder>');
  const folder =
    isAbsolute(wanted) || existsSync(wanted)
      ? resolve(wanted)
      : join(RUNS_DIR, existingRunId(RUNS_DIR, wanted));
  const { verdict, verdictText, written } = rebuildRun(folder);
  console.log(verdictText);
  console.log(`Written under ${folder}: ${written.join(', ')}`);
  return verdict === 'pass' ? 0 : 1;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}
