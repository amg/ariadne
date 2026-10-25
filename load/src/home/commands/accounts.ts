import { join } from 'node:path';
import { runGenerator } from '../generatorRun.ts';
import { parseAccountsCount } from '../options.ts';
import {
  devConnections,
  generatorEnvironment,
  hostAddress,
  loadAccountPassword,
  readDevEnvFile,
  withDevStack,
} from '../stack/index.ts';
import { followRequests } from '../watch/index.ts';
import { runCommand, runFolderOf, runIdOf } from './cli.ts';

/**
 * Creates the load accounts in dev through sign-up:
 *   npm run home:accounts --workspace=load -- [--users 300]
 *
 * Accounts that already exist are left as they are, so asking for more
 * extends the set. Dev's own backend must be stopped first.
 */
const SIGN_UPS_AT_ONCE = 4;
const SECONDS_PER_ACCOUNT = 5;

runCommand(async () => {
  const count = parseAccountsCount(process.argv.slice(2));
  const envFile = readDevEnvFile();
  const password = loadAccountPassword(process.env, envFile);
  const connections = devConnections(envFile, hostAddress());
  const runId = runIdOf(new Date(), 'dev-accounts');
  const folder = runFolderOf(runId);

  console.log(`Creating ${count} load accounts (${runId})`);
  await withDevStack({ folder, connections, inference: 'mock' }, (stack) =>
    runGenerator({
      folder,
      signal: stack.signal,
      timeoutMs: (count * SECONDS_PER_ACCOUNT + 120) * 1_000,
      env: generatorEnvironment(process.env.PATH, {
        runId,
        generator: 0,
        attempt: 1,
        mode: 'seed',
        backendUrl: stack.backendUrl,
        password,
        firstUser: 0,
        userCount: count,
        chattingShare: 0,
        rampSeconds: 0,
        holdSeconds: 0,
        endsAt: null,
        thinkSeconds: 1,
        seedConcurrency: SIGN_UPS_AT_ONCE,
        stateSeconds: 30,
      }),
    }),
  );

  const requests = followRequests();
  requests.follow(join(folder, 'generator.log'));
  const created = requests.soFar().succeeded.signup ?? 0;
  console.log(
    `Created ${created}; ${count - created} not created (already there, or see ${join(folder, 'generator.log')}).`,
  );
});
