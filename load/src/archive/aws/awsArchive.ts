import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LAYOUT, type Manifest, readManifest } from '../../records/index.ts';
import { writeWhole } from '../files.ts';
import type { RunDescription } from '../manifestBuilder.ts';
import { readPendingRun, savePendingRun } from '../pendingRun.ts';
import { sealRun } from '../sealRun.ts';
import { awsCollection, trailingEndOf } from './awsCollection.ts';
import { findingKeeper } from './keptFindings.ts';
import { keptGeneratorTasks, withKeptTasks } from './keptTasks.ts';
import type { awaitMetricsUntil } from './metricsWait.ts';
import { type Raise, expectedSourcesOf, raiseSchema } from './raise.ts';
import { generatorTasksOf } from './runEvents.ts';
import type { RaiseSources } from './sources.ts';

type AwsRunInput = Parameters<typeof awsCollection>[0]['run'];

type WaitForMetrics = Parameters<typeof awaitMetricsUntil>[0]['wait'];

/** What the step's configuration says about the plan a generator runs. */
const planOfConfig = z.object({
  load: z.object({ rampSeconds: z.number(), holdSeconds: z.number() }),
});

/**
 * Starts a run's record in its folder, before its generators start: what
 * the raise was made of, and how the run was described. A run folder that
 * has this and no manifest is visibly unsealed.
 */
export function beginAwsRun(input: {
  folder: string;
  raise: Raise;
  description: RunDescription;
}) {
  const { folder, raise, description } = input;
  mkdirSync(join(folder, LAYOUT.sourcesDir), { recursive: true });
  writeWhole(join(folder, LAYOUT.raise), JSON.stringify(raiseSchema.parse(raise), null, 2));
  savePendingRun(folder, { description, expected: expectedSourcesOf(raise) });
}

type AwsArchiveResult = { status: 'sealed' | 'already-sealed'; manifest: Manifest };

/** The moment the run ended, when nothing says: the last of its generators' stops. */
async function endOfRun(sources: RaiseSources, raise: Raise, folder: string) {
  const tasks = withKeptTasks(await sources.tasks(raise.clusters.load), keptGeneratorTasks(folder));
  const stops = generatorTasksOf(tasks)
    .flatMap(({ task }) => task.stoppedAt ?? [])
    .sort();
  return stops.at(-1) ?? null;
}

/**
 * Archives a run on aws-prod into its folder and seals it, with the
 * manifest written last. What the folder already holds of the run is
 * kept, so an archive that stopped resumes rather than starts again, and a
 * run already sealed is left as it is.
 */
export async function archiveAwsRun(input: {
  runId: string;
  folder: string;
  /** What the raise holds, once the run's record has said what the raise was. */
  sourcesFor: (raise: Raise) => RaiseSources;
  wait: WaitForMetrics;
  /** When the run ended, if the run's record does not say. */
  endedAt?: string;
  /** How the run ended, when the caller knows; otherwise how its generators stopped says. */
  outcome?: AwsRunInput['outcome'];
  now?: () => Date;
}): Promise<AwsArchiveResult> {
  const { runId, folder } = input;
  const manifestFile = join(folder, LAYOUT.manifest);
  if (existsSync(manifestFile)) {
    return { status: 'already-sealed', manifest: readManifest(readFileSync(manifestFile, 'utf8')) };
  }
  const pending = readPendingRun(folder);
  if (pending === null || !existsSync(join(folder, LAYOUT.raise))) {
    throw new Error(`${folder} holds no record of how ${runId} began, so it cannot be archived`);
  }
  const raise = raiseSchema.parse(JSON.parse(readFileSync(join(folder, LAYOUT.raise), 'utf8')));
  const sources = input.sourcesFor(raise);
  const endedAt =
    input.endedAt ?? pending.description.endedAt ?? (await endOfRun(sources, raise, folder));
  if (endedAt === null) {
    throw new Error(`Nothing says when ${runId} ended; give it with --ended`);
  }
  const description: RunDescription = {
    ...pending.description,
    endedAt,
    trailingEndsAt: trailingEndOf(endedAt),
  };
  savePendingRun(folder, { ...pending, description });

  const { manifest } = await sealRun({
    folder,
    description,
    expected: pending.expected,
    collection: awsCollection({
      folder,
      run: {
        raise,
        startedAt: description.startedAt,
        endedAt,
        outcome: input.outcome,
        plan: planOfConfig.parse(description.config).load,
      },
      sources,
      waitForDelivery: input.wait,
      now: input.now,
      keepFindings: findingKeeper(folder).keep,
    }),
    now: input.now,
  });
  return { status: 'sealed', manifest };
}
