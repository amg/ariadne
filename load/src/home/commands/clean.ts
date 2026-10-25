import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { devConnections, hostAddress, readDevEnvFile } from '../stack/index.ts';
import { runCommand } from './cli.ts';

/**
 * Deletes what the load accounts have built up in dev; the accounts stay:
 *   npm run home:clean --workspace=load
 */
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;

runCommand(async () => {
  const { databaseUrl } = devConnections(readDevEnvFile(), hostAddress());
  const cleaner = spawn(
    join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
    ['scripts/delete-load-account-data.ts'],
    {
      cwd: join(REPO_ROOT, 'backend'),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    },
  );
  const code = await new Promise<number | null>((resolve) => cleaner.once('exit', resolve));
  if (code !== 0) throw new Error(`The cleanup failed (exit ${code})`);
});
