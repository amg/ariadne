import { z } from 'zod';
import { STOP_REASONS } from './event.ts';
import { instant } from './instant.ts';
import { UnknownSchemaVersion } from './versioned.ts';

/** The self-checks an archive runs before it seals a run. */
const CHECKS = [
  'request-coverage',
  'request-totals',
  'services-recorded',
  'app-records',
  'sources-collected',
  'records-valid',
  'checksums',
] as const;

/** A check a run failed, with what it found. `path` names the file at fault, when one is. */
export const findingSchema = z.object({
  check: z.enum(CHECKS),
  detail: z.string(),
  path: z.string().nullable(),
});
export type Finding = z.infer<typeof findingSchema>;

const fileEntrySchema = z.object({
  path: z.string(),
  size: z.number().int(),
  sha256: z.string(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

/** The target of every run on aws-prod; home runs name the machine they ran on. */
export const AWS_PROD_TARGET = 'aws-prod';

const commitSchema = z.object({ sha: z.string(), dirty: z.boolean() });

/** A stretch in which a slice of users had no generator holding them, and why. */
const downWindowSchema = z.object({ from: instant, to: instant, reason: z.string() });
export type DownWindow = z.infer<typeof downWindowSchema>;

/** One attempt at running a slice, kept as the slice's history. */
const attemptSchema = z.object({
  attempt: z.number().int(),
  task: z.string(),
  spot: z.boolean(),
  startedAt: instant,
  stoppedAt: instant.nullable(),
  stoppedBecause: z.enum(STOP_REASONS).nullable(),
  stopDetail: z.string().nullable(),
  /** When the generator was told to stop; null when the record does not say. */
  toldToStopAt: instant.nullable(),
  /** Whether the run's end stopped it, so that its slice ended with the run and was not lost. */
  stoppedForRunEnd: z.boolean(),
});

/**
 * One generator's share of the users over the whole run, whichever
 * generator held them at the time.
 */
const sliceSchema = z.object({
  generator: z.number().int(),
  firstUser: z.number().int(),
  userCount: z.number().int(),
  /** When the slice's first generator started. */
  startedAt: instant,
  /**
   * When the slice's last generator stopped holding its users: when it was
   * told to stop, else when it stopped; null when no stop was recorded.
   */
  endedAt: instant.nullable(),
  /**
   * When the slice held its users: from when its first generator began
   * holding them to when its plan said to stop; null for a slice with no plan.
   */
  hold: z.object({ from: instant, to: instant }).nullable(),
  /** Every window in which the slice had no generator holding its users, oldest first. */
  down: z.array(downWindowSchema),
  /** Every generator that ran the slice, in the order they ran. */
  attempts: z.array(attemptSchema).min(1),
});
export type ManifestSlice = z.infer<typeof sliceSchema>;

/** The schema version of a run folder, raised whenever any of its files changes shape. */
export const RUN_FOLDER_VERSION = 2;

/**
 * What a run was, and every file in it. It is written last: a run
 * without one is unfinished. A `seal` that is not `complete` can never be
 * judged a pass.
 */
export const manifestSchema = z.object({
  /** The schema version of the whole run folder. */
  version: z.literal(RUN_FOLDER_VERSION),
  runId: z.string(),
  step: z.string(),
  /** The step's whole configuration, as the run was given it. */
  config: z.record(z.string(), z.unknown()),
  target: z.string(),
  loadPath: z.enum(['direct', 'cloudflare']),
  images: z.record(z.string(), z.string()),
  commits: z.object({ app: commitSchema, harness: commitSchema }),
  startedAt: instant,
  endedAt: instant.nullable(),
  /** When the stretch after the run's end, which the archive also collected, ends; null for a run with none. */
  trailingEndsAt: instant.nullable(),
  /** The limits the run is judged by, as they stood when it began; null for a step that had none. */
  limits: z.record(z.string(), z.number()).nullable(),
  slices: z.array(sliceSchema),
  files: z.array(fileEntrySchema),
  seal: z.discriminatedUnion('status', [
    z.object({ status: z.literal('complete'), sealedAt: instant }),
    z.object({
      status: z.literal('incomplete'),
      sealedAt: instant,
      reasons: z.array(findingSchema).min(1),
    }),
  ]),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** Reads a manifest from its JSON text, refusing a run folder of a version this reader does not know. */
export function readManifest(text: string) {
  const document: unknown = JSON.parse(text);
  const version =
    typeof document === 'object' && document !== null && 'version' in document
      ? document.version
      : undefined;
  if (version !== RUN_FOLDER_VERSION) throw new UnknownSchemaVersion(version, RUN_FOLDER_VERSION);
  return manifestSchema.parse(document);
}
