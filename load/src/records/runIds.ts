import { readdirSync } from 'node:fs';

/**
 * The id of the run folder among `runsDir` that `wanted` names: the id
 * itself, or the start of an id that no other id also starts with, such as
 * the run's timestamp alone. Throws when `wanted` names no run, or names
 * several and says which.
 */
export function existingRunId(runsDir: string, wanted: string) {
  if (wanted === '') throw new Error('Name a run by its id, or by the start of it.');
  const runIds = runFolderNames(runsDir);
  if (runIds.includes(wanted)) return wanted;
  const matching = runIds.filter((runId) => runId.startsWith(wanted)).sort();
  const [only, ...others] = matching;
  if (only === undefined) throw new Error(`No run matches "${wanted}" in ${runsDir}`);
  if (others.length === 0) return only;
  throw new Error(`"${wanted}" matches several runs: ${matching.join(', ')}. Name one in full.`);
}

function runFolderNames(runsDir: string) {
  try {
    return readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}
