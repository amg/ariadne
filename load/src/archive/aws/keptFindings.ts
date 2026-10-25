import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { type Finding, LAYOUT, findingSchema } from '../../records/index.ts';
import { writeWhole } from '../files.ts';

const KEPT_FINDINGS = `${LAYOUT.sourcesDir}/findings.json`;

/** A finding about a file of the run, kept for as long as that file is. */
const keptSchema = z.array(z.object({ file: z.string(), finding: findingSchema }));

function readKept(folder: string) {
  const file = join(folder, KEPT_FINDINGS);
  if (!existsSync(file)) return [];
  return keptSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** The findings kept about files the run's folder holds. A finding about a file that is not there says nothing of a file collected anew. */
export function keptFindings(folder: string): readonly Finding[] {
  return readKept(folder)
    .filter(({ file }) => existsSync(join(folder, file)))
    .map(({ finding }) => finding);
}

/**
 * Keeps findings about a file the archive wrote from what a source still
 * held. That file is not collected again, so its findings are kept in the
 * run's folder for any later archive of the run.
 */
export function findingKeeper(folder: string): {
  keep: (file: string, findings: readonly Finding[]) => void;
} {
  return {
    keep(file, findings) {
      const kept = readKept(folder);
      const added = findings
        .filter(
          (finding) =>
            !kept.some(
              (known) =>
                known.file === file && JSON.stringify(known.finding) === JSON.stringify(finding),
            ),
        )
        .map((finding) => ({ file, finding }));
      if (added.length > 0) {
        writeWhole(join(folder, KEPT_FINDINGS), JSON.stringify([...kept, ...added], null, 2));
      }
    },
  };
}
