import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  InvalidRecordLine,
  LAYOUT,
  type Manifest,
  type RecordKind,
  appRequestRecords,
  appStateRecords,
  awsEventRecords,
  eventRecords,
  exchangeRecords,
  hostSampleRecords,
  insightRecords,
  jobRecords,
  metricSeriesRecords,
  readManifest,
  requestRecords,
  sha256Of,
  sha256OfFile,
  stateRecords,
} from '../../records/index.ts';
import type { RunData, Trouble } from '../types.ts';
import { splitAtRunEnd } from './afterRun.ts';

/** A run's manifest is missing: the run was never sealed, so there is nothing to rebuild from. */
class RunNotSealed extends Error {}

/** What reading one source gave: its records, null when it is unusable, and what was wrong with it. */
type Read<Records> = { records: Records | null; trouble: readonly Trouble[] };

/**
 * Reads a sealed run folder. Only files the manifest lists are used, and
 * a file that no longer matches its checksum is set aside, because raw
 * files do not change after sealing. A run folder of a schema version this
 * reader does not know is refused, not guessed at.
 */
export function loadRun(folder: string): RunData {
  const manifestFile = join(folder, LAYOUT.manifest);
  if (!existsSync(manifestFile)) {
    throw new RunNotSealed(`${folder} has no manifest: the run was never sealed`);
  }
  const manifest = readManifest(readFileSync(manifestFile, 'utf8'));
  const files = usableFiles(folder, manifest);
  const lines = <Schema extends z.ZodType>(path: string, kind: RecordKind<Schema>) =>
    readLines(path, kind, files.usable);

  const events = lines(LAYOUT.events, eventRecords);
  const slices = manifest.slices.map((slice) => ({
    slice,
    requests: lines(LAYOUT.requests(slice.generator), requestRecords),
    states: lines(LAYOUT.generatorState(slice.generator), stateRecords),
  }));
  const host = lines(LAYOUT.hostSamples, hostSampleRecords);
  const exchanges = lines(LAYOUT.exchanges, exchangeRecords);
  const jobs = lines(LAYOUT.jobs, jobRecords);
  const appRequests = lines(LAYOUT.appRequests, appRequestRecords);
  const appStates = lines(LAYOUT.appState, appStateRecords);
  const insights = lines(LAYOUT.insights, insightRecords);
  const awsEvents = lines(LAYOUT.awsEvents, awsEventRecords);
  const awsMetrics = awsMetricPathsOf(manifest).map((path) => ({
    path,
    read: lines(path, metricSeriesRecords),
  }));
  const appRecords = splitAtRunEnd(manifest, {
    exchanges: exchanges.records,
    jobs: jobs.records,
    appRequests: appRequests.records,
    appStates: appStates.records,
  });

  return {
    manifest,
    events: events.records,
    slices: slices.map(({ slice, requests, states }) => ({
      slice,
      requests: requests.records,
      states: states.records,
    })),
    host: host.records,
    exchanges: appRecords.inRun.exchanges,
    jobs: appRecords.inRun.jobs,
    appRequests: appRecords.inRun.appRequests,
    appStates: appRecords.inRun.appStates,
    afterRun: appRecords.afterRun,
    insights: insights.records,
    awsMetrics: awsMetrics.flatMap(({ path, read }) =>
      read.records === null ? [] : [{ resource: resourceOf(path), path, series: read.records }],
    ),
    awsEvents: awsEvents.records,
    trouble: [
      ...files.trouble,
      ...events.trouble,
      ...slices.flatMap(({ requests, states }) => [...requests.trouble, ...states.trouble]),
      ...[
        host,
        exchanges,
        jobs,
        appRequests,
        appStates,
        insights,
        awsEvents,
        ...awsMetrics.map(({ read }) => read),
      ].flatMap(({ trouble }) => trouble),
    ],
  };
}

/** The files of CloudWatch metrics the manifest lists, one per resource, in the order it lists them. */
function awsMetricPathsOf(manifest: Manifest) {
  return manifest.files
    .map((entry) => entry.path)
    .filter((path) => path.startsWith(`${LAYOUT.awsMetricsDir}/`) && path.endsWith('.jsonl'));
}

/** The resource a file of CloudWatch metrics is named after. */
function resourceOf(path: string) {
  return path.slice(LAYOUT.awsMetricsDir.length + 1, -'.jsonl'.length);
}

/** The files of a run that are unchanged since it was sealed, which are read when asked for. */
type UsableFiles = {
  /** The content of a file the manifest lists that is there and unchanged; undefined for any other. */
  get: (path: string) => Buffer | undefined;
};

/**
 * Checks every file the manifest lists against its size and checksum, a
 * piece at a time, so that no file is held in memory until it is read. Files
 * that are gone or changed are the trouble.
 */
function usableFiles(
  folder: string,
  manifest: Manifest,
): { usable: UsableFiles; trouble: readonly Trouble[] } {
  const intact = new Map<string, string>();
  const trouble: Trouble[] = [];
  for (const entry of manifest.files) {
    const file = join(folder, entry.path);
    if (!existsSync(file)) {
      trouble.push({ path: entry.path, reason: 'is gone since the run was sealed' });
      continue;
    }
    if (statSync(file).size === entry.size && sha256OfFile(file) === entry.sha256) {
      intact.set(entry.path, entry.sha256);
    } else {
      trouble.push({ path: entry.path, reason: 'changed since the run was sealed' });
    }
  }
  return {
    usable: {
      get(path) {
        const checksum = intact.get(path);
        if (checksum === undefined) return undefined;
        // Checked again as it is read, so that what is parsed is what was checked.
        const content = readFileSync(join(folder, path));
        return sha256Of(content) === checksum ? content : undefined;
      },
    },
    trouble,
  };
}

function readLines<Schema extends z.ZodType>(
  path: string,
  kind: RecordKind<Schema>,
  usable: UsableFiles,
): Read<z.infer<Schema>[]> {
  const file = usable.get(path);
  if (file === undefined) return { records: null, trouble: [] };
  try {
    return { records: kind.readLines(file.toString('utf8')), trouble: [] };
  } catch (error) {
    if (!(error instanceof InvalidRecordLine)) throw error;
    return { records: null, trouble: [{ path, reason: `not valid: ${error.message}` }] };
  }
}
