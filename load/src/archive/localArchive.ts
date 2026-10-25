import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding, LAYOUT, type Manifest, readManifest } from '../records/index.ts';
import { attemptsBySlice } from './attempts.ts';
import { checkSealed } from './checkSealed.ts';
import { collectAppRecords, collectSliceOutput } from './collect.ts';
import type { RunDescription } from './manifestBuilder.ts';
import { sealRun } from './sealRun.ts';
import type { ExpectedSource } from './selfChecks.ts';

type Collection = Parameters<typeof sealRun>[0]['collection'];

type LocalArchiveInput = {
  /** The run's folder, where the run left everything it recorded. */
  folder: string;
  description: RunDescription;
  /** The logs and metrics the run must have left. */
  expected: readonly ExpectedSource[];
  now?: () => Date;
};

type ArchiveResult =
  | {
      status: 'sealed';
      manifest: Manifest;
      /** Paths written by this archive, and paths it found already holding what it would write. */
      written: readonly string[];
      skipped: readonly string[];
    }
  | {
      status: 'already-sealed';
      manifest: Manifest;
      /** Files that no longer match the manifest. Nothing was changed to repair them. */
      problems: Finding[];
    };

/**
 * Collects a local run into its folder and seals it with its manifest,
 * which is written last. A run that fails a self-check is sealed as
 * incomplete, and its manifest lists the findings.
 *
 * A file that already holds what would be written is left untouched, so
 * an archive that failed part way resumes where it stopped. A run that
 * already has its manifest is not touched at all.
 */
export async function archiveLocalRun(input: LocalArchiveInput): Promise<ArchiveResult> {
  const { folder, description } = input;
  const manifestPath = join(folder, LAYOUT.manifest);
  if (existsSync(manifestPath)) {
    const manifest = readManifest(readFileSync(manifestPath, 'utf8'));
    const problems = checkSealed(folder, manifest);
    return { status: 'already-sealed', manifest, problems };
  }
  const now = input.now ?? (() => new Date());
  const sealed = await sealRun({
    folder,
    description,
    expected: input.expected,
    collection: localCollection(folder),
    now,
  });
  return { status: 'sealed', ...sealed };
}

function localCollection(folder: string): Collection {
  return {
    async collect({ put, putAllFrom, attempts }) {
      for (const slice of attemptsBySlice(attempts)) {
        const tries = slice.attempts.map(({ attempt }) => attempt);
        await collectSliceOutput(folder, slice.generator, tries, { put, putAllFrom });
      }
      await collectAppRecords(folder, ['backend'], { putAllFrom });
      return [];
    },
  };
}
