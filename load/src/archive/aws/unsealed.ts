import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LAYOUT } from '../../records/index.ts';

/** When a run began, from the start of its id; null for an id that does not begin with a time. */
function startOfRunIdOrNull(runId: string) {
  const found = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(runId);
  if (found === null) return null;
  const [year, month, day, hour, minute, second] = found.slice(1).map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day, hour, minute, second));
}

/**
 * The aws-prod runs in `runsDir` begun at or after `since` that have no
 * manifest, oldest first. A raise's runs begin after the raise does, so the
 * raise's creation time picks them out. A `since` that is no moment is
 * refused, because every run would then read as sealed.
 */
export function unsealedRunsSince(runsDir: string, since: Date) {
  if (Number.isNaN(since.getTime())) throw new Error('The moment to look from is not a valid time');
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => existsSync(join(runsDir, id, LAYOUT.raise)))
    .filter((id) => {
      const began = startOfRunIdOrNull(id);
      if (began === null)
        throw new Error(`The run id ${id} does not begin with a time, so it cannot be placed`);
      return began.getTime() >= since.getTime();
    })
    .filter((id) => !existsSync(join(runsDir, id, LAYOUT.manifest)))
    .sort();
}
