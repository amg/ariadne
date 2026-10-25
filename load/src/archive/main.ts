import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { existingRunId } from '../records/index.ts';
import { archiveAwsRun } from './aws/awsArchive.ts';
import { METRICS_WAIT } from './aws/metricsWait.ts';
import { awsSources } from './aws/sdk/index.ts';
import { unsealedRunsSince } from './aws/unsealed.ts';

const RUNS_DIR = new URL('../../.runs/', import.meta.url).pathname;

const OUTCOME = z.enum(['finished', 'interrupted', 'failed']).optional();

const USAGE = `usage:
  archive seal --run <id> [--ended <instant>] [--outcome finished|interrupted|failed]
  archive unsealed --since <instant>`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    run: { type: 'string' },
    ended: { type: 'string' },
    outcome: { type: 'string' },
    since: { type: 'string' },
  },
});

function required(name: keyof typeof values) {
  const value = values[name];
  if (typeof value !== 'string' || value === '') throw new Error(`--${name} is required\n${USAGE}`);
  return value;
}

const folderOf = (runId: string) => join(RUNS_DIR, runId);

/** Seals a run the load command could not, or resumes the archive of one that stopped part way. */
async function seal(): Promise<void> {
  const runId = existingRunId(RUNS_DIR, required('run'));
  const outcome = OUTCOME.safeParse(values.outcome);
  if (!outcome.success) throw new Error('--outcome is finished, interrupted or failed');
  const result = await archiveAwsRun({
    runId,
    folder: folderOf(runId),
    sourcesFor: awsSources,
    wait: METRICS_WAIT,
    endedAt: values.ended,
    outcome: outcome.data,
  });
  const { seal: sealed } = result.manifest;
  console.log(
    result.status === 'already-sealed'
      ? `${runId} was already sealed as ${sealed.status}; nothing was changed`
      : `${runId} sealed as ${sealed.status} in ${folderOf(runId)}`,
  );
  if (sealed.status === 'incomplete') {
    for (const reason of sealed.reasons) console.error(`  ${reason.check}: ${reason.detail}`);
  }
}

async function unsealed() {
  const since = new Date(required('since'));
  for (const id of unsealedRunsSince(RUNS_DIR, since)) {
    console.log(id);
  }
}

const commands: Record<string, () => Promise<void>> = {
  seal,
  unsealed,
};
const [command] = positionals;
const run = command === undefined ? undefined : commands[command];
if (run === undefined) {
  console.error(USAGE);
  process.exit(2);
}
run().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
