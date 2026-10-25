import { join } from 'node:path';
import { existingRunId } from '../../records/index.ts';
import { Interrupted } from '../stack/index.ts';
import { GuardTripped } from '../watch/index.ts';

const RUNS_DIR = new URL('../../../.runs/', import.meta.url).pathname;

/** A new run's id: its start time in UTC, then what it is. */
export function runIdOf(now: Date, what: string) {
  return `${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}-${what}`;
}

/** Where a run keeps its output. */
export function runFolderOf(runId: string) {
  return join(RUNS_DIR, runId);
}

/** Where an earlier run keeps its output, named by its id in full or by the start of it, such as its timestamp. */
export function existingRunFolderOf(wanted: string) {
  return runFolderOf(existingRunId(RUNS_DIR, wanted));
}

/** Runs a command's main function, turning a refusal, a failure, an interrupt or a stop by the guard into an exit code. */
export function runCommand(main: () => Promise<void>) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      if (error instanceof Interrupted) {
        console.error(`${error.message}; the backend and mock were stopped.`);
        process.exit(130);
      }
      if (error instanceof GuardTripped) {
        console.error(`${error.message}; the backend, mock and generator were stopped.`);
        process.exit(3);
      }
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
