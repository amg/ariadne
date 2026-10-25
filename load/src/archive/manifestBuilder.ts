import type { z } from 'zod';
import {
  type FileEntry,
  type Finding,
  type Manifest,
  type ManifestSlice,
  RUN_FOLDER_VERSION,
  manifestSchema,
} from '../records/index.ts';

/** What the run command knows about a run, which no file records by itself. */
export const runDescriptionSchema = manifestSchema.pick({
  runId: true,
  step: true,
  config: true,
  target: true,
  loadPath: true,
  images: true,
  commits: true,
  limits: true,
  startedAt: true,
  endedAt: true,
  trailingEndsAt: true,
});
export type RunDescription = z.infer<typeof runDescriptionSchema>;

/** The manifest of a run: what it was, every file in it, and whether it passed its own checks. */
export function buildManifest(input: {
  description: RunDescription;
  slices: readonly ManifestSlice[];
  files: readonly FileEntry[];
  findings: readonly Finding[];
  sealedAt: Date;
}): Manifest {
  const { description, findings } = input;
  const [first, ...others] = findings;
  const sealedAt = input.sealedAt.toISOString();
  return {
    version: RUN_FOLDER_VERSION,
    runId: description.runId,
    step: description.step,
    config: description.config,
    target: description.target,
    loadPath: description.loadPath,
    images: description.images,
    commits: description.commits,
    startedAt: description.startedAt,
    endedAt: description.endedAt,
    trailingEndsAt: description.trailingEndsAt,
    limits: description.limits,
    slices: [...input.slices],
    files: [...input.files],
    seal:
      first === undefined
        ? { status: 'complete', sealedAt }
        : { status: 'incomplete', sealedAt, reasons: [first, ...others] },
  };
}
