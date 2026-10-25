import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { archiveLocalRun, readPendingRun } from '../../archive/index.ts';
import { LAYOUT, readManifest } from '../../records/index.ts';
import { existingRunFolderOf, runCommand } from './cli.ts';

/**
 * Archives a run whose own archive failed, or looks at one already sealed:
 *   npm run home:archive --workspace=load -- <run id>
 *
 * The run id may be the start of it, such as its timestamp.
 *
 * Files the failed archive already wrote are left as they are. A run that
 * is already sealed is not touched.
 */
runCommand(async () => {
  const runId = process.argv[2];
  if (runId === undefined) throw new Error('usage: home:archive <run id>');
  const folder = existingRunFolderOf(runId);

  const manifestPath = join(folder, LAYOUT.manifest);
  if (existsSync(manifestPath)) {
    const { seal } = readManifest(readFileSync(manifestPath, 'utf8'));
    console.log(`Already sealed as ${seal.status}; nothing was changed.`);
    return;
  }
  const pending = readPendingRun(folder);
  if (pending === null) throw new Error(`${folder} holds no record of how the run was described`);

  const archived = await archiveLocalRun({ folder, ...pending });
  console.log(`Sealed as ${archived.manifest.seal.status}: ${folder}`);
});
