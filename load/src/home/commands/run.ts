import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LAYOUT } from '../../records/index.ts';
import { HOME_STEP, carryOut, finishRun } from '../homeRun.ts';
import { parseRunOptions } from '../options.ts';
import {
  devConnections,
  hostAddress,
  loadAccountPassword,
  readDevEnvFile,
} from '../stack/index.ts';
import { DEFAULT_GLANCES_URL, readHostSample } from '../watch/index.ts';
import { runCommand, runFolderOf, runIdOf } from './cli.ts';

/**
 * A small load against dev on this machine, from this machine:
 *   npm run home:run --workspace=load -- [--users 20] [--hold-minutes 11]
 *     [--generators 4] [--inference mock|real]
 *     [--max-host-cpu 70] [--max-memory-percent 80] [--max-first-byte-ms 2500] [--max-error-percent 1]
 *
 * It starts its own backend on dev's database and auth core, and the mock
 * inference unless `--inference real` is given. Both are stopped when the
 * run ends. Dev's own backend must be stopped first.
 *
 * It proves the harness works and that a run can be driven end to end; the
 * home machine is not a stress target. The users are shared between several
 * generators, each on its own slice. A generator that stops before the
 * run's end, such as one killed by hand, is relaunched on the same slice:
 * its users come back over about a minute, and it holds only for the time
 * the run has left. Each generator's process id is printed as it starts.
 * The verdict names a lost slice and how long it was down.
 *
 * While it runs, the host is read from Glances (GLANCES_URL, or the home
 * machine's own) and the run stops itself when a guard line is crossed.
 * The guard's lines can be tightened with the last four options, never
 * loosened.
 *
 * Every run ends as a sealed run folder, whether it finished, was stopped
 * by the guard, was interrupted or failed. The command returns only once
 * the folder is sealed and its verdict is written beside it, under `derived/`.
 */
runCommand(async () => {
  const options = parseRunOptions(process.argv.slice(2));
  const envFile = readDevEnvFile();
  const password = loadAccountPassword(process.env, envFile);
  const connections = devConnections(envFile, hostAddress());
  const glancesUrl = process.env.GLANCES_URL || DEFAULT_GLANCES_URL;
  const startedAt = new Date();
  const runId = runIdOf(startedAt, `${HOME_STEP}-${options.inference}`);
  const folder = runFolderOf(runId);

  await readHostSample(glancesUrl).catch((error: unknown) => {
    throw new Error(
      `The guard cannot see the host: Glances does not answer at ${glancesUrl} (${error instanceof Error ? error.message : error})`,
    );
  });
  console.log(
    `Run ${runId}: ${options.users} users, ${options.inference} inference, guarded from ${glancesUrl}`,
  );
  const run = { options, runId, folder, startedAt, password, glancesUrl, connections };
  const { failure } = await carryOut(run);
  let sealedIncomplete = false;
  let passed = false;

  // A run refused before it began leaves no folder to seal.
  if (existsSync(folder)) {
    const { incompleteBecause, rebuilt } = await finishRun({ run, failure });
    for (const reason of incompleteBecause) {
      console.error(`Sealed as incomplete: ${reason.detail}`);
    }
    sealedIncomplete = incompleteBecause.length > 0;
    passed = rebuilt.verdict === 'pass';
    console.log(`Verdict: ${rebuilt.verdict}`);
    for (const reason of rebuilt.reasons) console.log(`  ${reason}`);
    console.log(`Verdict and numbers: ${join(folder, LAYOUT.derivedDir)}`);
  }
  if (failure !== null) throw failure;
  if (sealedIncomplete)
    throw new Error(`The run folder was sealed as incomplete; see ${folder}/manifest.json`);
  if (!passed) throw new Error(`The run did not pass; see ${join(folder, LAYOUT.verdict)}`);

  console.log('The run passed, and the guard held: no line was crossed.');
  console.log(`Output: ${folder}`);
});
