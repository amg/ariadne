import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import {
  type FileEntry,
  type Finding,
  LAYOUT,
  type Manifest,
  type RecordKind,
  type Report,
  type RequestLine,
  appRequestRecords,
  appStateRecords,
  awsEventRecords,
  eventRecords,
  exchangeRecords,
  hostSampleRecords,
  insightRecords,
  isChat,
  jobRecords,
  metricSeriesRecords,
  reportRecords,
  requestRecords,
  stateRecords,
} from '../records/index.ts';
import { type Attempt, attemptsBySlice, attemptsOf } from './attempts.ts';
import { PARTIAL, describeFile, listRunFiles, sha256Of, writeOnce } from './files.ts';
import { linesOfFile } from './lines.ts';
import { type RunDescription, buildManifest } from './manifestBuilder.ts';
import {
  type AttemptFacts,
  type ExpectedSource,
  type RequestFacts,
  checkAppRecords,
  checkChecksums,
  checkGeneratorsRan,
  checkRequestCoverage,
  checkRequestTotals,
  checkServicesRecorded,
} from './selfChecks.ts';
import { slicesOf } from './slices.ts';

/** Writes a file of the run unless one already holds exactly that. */
type Put = (path: string, content: string) => void;

/**
 * Writes a file of the run too big to hold in memory: `fill` writes it
 * into the path it is given, and the file takes its place only once
 * `fill` is done. Nothing is done when the file is already there.
 */
type PutFrom = (path: string, fill: (partialFile: string) => Promise<void>) => Promise<void>;

/**
 * Writes several files of the run at once, as when one pass through a big
 * input sorts it into them. `fill` is given the path of each file's partial
 * copy, in the order of `paths`, and the files take their places only once
 * `fill` is done. Nothing is done when every file is already there.
 */
type PutAllFrom = (
  paths: readonly string[],
  fill: (partialFiles: string[]) => Promise<void>,
) => Promise<void>;

/** What a run's collection works with. */
export type CollectionContext = {
  put: Put;
  putFrom: PutFrom;
  putAllFrom: PutAllFrom;
};

/** What a run's collection works with once the run's events are read. */
export type CollectContext = CollectionContext & {
  /** Every generator attempt the run's events show launched. */
  attempts: readonly Attempt[];
};

/** How a run's files get into its folder, which differs between where runs happen. */
type Collection = {
  /** Writes what the run's events come from, before anything reads them. */
  prepare?: (context: CollectionContext) => Promise<readonly Finding[]>;
  /**
   * Writes everything else the run left, for every generator attempt the
   * run's events show. Each source that could not be collected is a finding,
   * which seals the run as incomplete.
   */
  collect: (context: CollectContext) => Promise<readonly Finding[]>;
};

type SealInput = {
  /** The run's folder, where the run left everything it recorded. */
  folder: string;
  description: RunDescription;
  /** The logs and metrics the run must have left. */
  expected: readonly ExpectedSource[];
  collection: Collection;
  now?: () => Date;
};

type SealedRun = {
  manifest: Manifest;
  /** Paths written by this archive, and paths it found already holding what it would write. */
  written: readonly string[];
  skipped: readonly string[];
};

/**
 * Collects a run into its folder and seals it with its manifest, which is
 * written last. A run that fails a self-check is sealed as incomplete, and
 * its manifest lists the findings.
 *
 * A file that already holds what would be written is left untouched, so
 * an archive that failed part way resumes where it stopped.
 */
export async function sealRun(input: SealInput): Promise<SealedRun> {
  const { folder, description } = input;
  const manifestPath = join(folder, LAYOUT.manifest);
  const now = input.now ?? (() => new Date());
  const findings: Finding[] = [];
  const collector = createCollector(folder);

  const context = {
    put: collector.put,
    putFrom: collector.putFrom,
    putAllFrom: collector.putAllFrom,
  };
  findings.push(...((await input.collection.prepare?.(context)) ?? []));
  const events = readEvents(folder, findings);
  const attempts = attemptsOf(events);
  findings.push(...(await input.collection.collect({ ...context, attempts })));

  const reader = createRecordReader(folder, findings);
  const reports = new Map<string, Report | null>();
  const reportOf = (generator: number, attempt: number): Report | null => {
    const path = LAYOUT.generatorReport(generator, attempt);
    const known = reports.get(path);
    if (known !== undefined) return known;
    const report = reader.readReport(path);
    reports.set(path, report);
    return report;
  };

  const lastStates = new Map<string, string>();
  const facts: AttemptFacts[] = [];
  let chatsStreamed = 0;
  for (const slice of attemptsBySlice(attempts)) {
    const requestsPath = LAYOUT.requests(slice.generator);
    const owned = slice.attempts.map((attempt) => ({ attempt, tally: createRequestTally() }));
    const tallyOf = new Map(owned.map(({ attempt, tally }) => [attempt.attempt, tally]));
    let streamed = 0;
    const read = await reader.scan(requestsPath, requestRecords, (line) => {
      tallyOf.get(line.attempt)?.add(line);
      if (isChat(line) && line.outcome === 'streamed') streamed += 1;
    });
    await reader.scan(LAYOUT.generatorState(slice.generator), stateRecords, (line) => {
      lastStates.set(attemptKey(slice.generator, line.attempt), line.at);
    });
    // A file that exists but does not parse has been reported; its counts would only repeat that.
    if (!read && reader.exists(requestsPath)) continue;
    chatsStreamed += streamed;
    for (const { attempt, tally } of owned) {
      facts.push({
        attempt,
        requestsPath,
        requests: tally.facts(read),
        report: reportOf(attempt.generator, attempt.attempt),
      });
    }
  }
  const window = {
    from: Date.parse(description.startedAt),
    to: description.endedAt === null ? now().getTime() : Date.parse(description.endedAt),
  };
  findings.push(
    ...checkGeneratorsRan(attempts.length),
    ...checkRequestCoverage(facts),
    ...checkRequestTotals(facts),
    ...checkServicesRecorded(input.expected, (source) => sourceFactsOf(source, reader, window)),
    ...(await appRecordFindings(reader, chatsStreamed)),
  );
  await reader.checkTheRest();

  const files = listRunFiles(folder)
    .map((path) => describeFile(folder, path))
    .filter((entry): entry is FileEntry => entry !== null);
  findings.push(
    ...checkChecksums(
      [...collector.recorded.values()],
      (path) => files.find((entry) => entry.path === path) ?? null,
    ),
  );

  const slices = slicesOf(attempts, {
    reportOf,
    lastStateAt: (generator, attempt) => lastStates.get(attemptKey(generator, attempt)) ?? null,
    runEndedAt: description.endedAt ?? now().toISOString(),
  });
  const manifest = buildManifest({
    description,
    slices,
    files,
    findings,
    sealedAt: now(),
  });
  const pending = `${manifestPath}.pending`;
  writeFileSync(pending, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(pending, manifestPath);
  rmSync(join(folder, LAYOUT.sourcesDir), { recursive: true, force: true });
  return { manifest, written: collector.written, skipped: collector.skipped };
}

/** Writes files into the run folder one at a time, keeping what each should hold and which it wrote or found already there. */
function createCollector(folder: string): {
  written: string[];
  skipped: string[];
  recorded: Map<string, FileEntry>;
  put: Put;
  putFrom: PutFrom;
  putAllFrom: PutAllFrom;
} {
  const written: string[] = [];
  const skipped: string[] = [];
  const recorded = new Map<string, FileEntry>();
  for (const path of listRunFiles(folder)) {
    const entry = describeFile(folder, path);
    if (entry !== null) recorded.set(path, entry);
  }
  const putAllFrom: PutAllFrom = async (paths, fill) => {
    if (paths.every((path) => recorded.has(path))) {
      skipped.push(...paths);
      return;
    }
    const partials = paths.map((path) => join(folder, `${path}${PARTIAL}`));
    for (const partial of partials) mkdirSync(dirname(partial), { recursive: true });
    await fill(partials);
    for (const [index, path] of paths.entries()) {
      renameSync(partials[index] ?? '', join(folder, path));
      const entry = describeFile(folder, path);
      if (entry !== null) recorded.set(path, entry);
      written.push(path);
    }
  };
  return {
    written,
    skipped,
    recorded,
    put(path, content): void {
      (writeOnce(folder, path, content) ? written : skipped).push(path);
      recorded.set(path, { path, size: Buffer.byteLength(content), sha256: sha256Of(content) });
    },
    putFrom: (path, fill) => putAllFrom([path], ([partial]) => fill(partial ?? '')),
    putAllFrom,
  };
}

/** Names one attempt at running a slice. */
const attemptKey = (generator: number, attempt: number) => `${generator}/${attempt}`;

/**
 * What an attempt's request lines show, as they are added one at a time:
 * how many there are, of which kinds, and when the first began and the
 * last ended.
 */
function createRequestTally(): {
  add: (line: RequestLine) => void;
  facts: (present: boolean) => RequestFacts;
} {
  const byKind: RequestFacts['byKind'] = {};
  let count = 0;
  let firstStartedAt: number | null = null;
  let lastEndedAt: number | null = null;
  return {
    add(line) {
      count += 1;
      byKind[line.kind] = (byKind[line.kind] ?? 0) + 1;
      const started = Date.parse(line.startedAt);
      const ended = started + line.totalMs;
      firstStartedAt = firstStartedAt === null ? started : Math.min(firstStartedAt, started);
      lastEndedAt = lastEndedAt === null ? ended : Math.max(lastEndedAt, ended);
    },
    facts: (present) =>
      present
        ? {
            present: true,
            count,
            byKind,
            firstStartedAt: firstStartedAt === null ? null : new Date(firstStartedAt).toISOString(),
            lastEndedAt: lastEndedAt === null ? null : new Date(lastEndedAt).toISOString(),
          }
        : { present: false, count: 0, byKind: {}, firstStartedAt: null, lastEndedAt: null },
  };
}

/**
 * What the self-check finds of the backend's records. A file that exists
 * but does not validate has been reported as such already, and its counts
 * would only repeat that.
 */
async function appRecordFindings(reader: RecordReader, chatsStreamed: number) {
  const exchanges = { count: 0, streamed: 0 };
  let jobs = 0;
  let states = 0;
  const read = {
    exchanges: await reader.scan(LAYOUT.exchanges, exchangeRecords, (line) => {
      exchanges.count += 1;
      if (line.firstTokenAfterMs !== null) exchanges.streamed += 1;
    }),
    jobs: await reader.scan(LAYOUT.jobs, jobRecords, () => {
      jobs += 1;
    }),
    states: await reader.scan(LAYOUT.appState, appStateRecords, () => {
      states += 1;
    }),
  };
  const unreadable =
    (!read.exchanges && reader.exists(LAYOUT.exchanges)) ||
    (!read.jobs && reader.exists(LAYOUT.jobs)) ||
    (!read.states && reader.exists(LAYOUT.appState));
  if (unreadable) return [];
  return checkAppRecords({
    exchanges: read.exchanges ? exchanges : null,
    jobs: read.jobs ? jobs : null,
    states: read.states ? states : null,
    chatsStreamed,
  });
}

function readEvents(folder: string, findings: Finding[]) {
  const path = LAYOUT.events;
  if (!existsSync(join(folder, path))) {
    findings.push({
      check: 'records-valid',
      detail: `${path} is missing, so the run's generators are unknown`,
      path,
    });
    return [];
  }
  return createRecordReader(folder, findings).read(path, eventRecords) ?? [];
}

type RecordReader = ReturnType<typeof createRecordReader>;

function sourceFactsOf(
  source: ExpectedSource,
  reader: RecordReader,
  window: { from: number; to: number },
) {
  if (source.kind === 'logs') return { present: reader.exists(source.path), recordsInWindow: null };
  const samples = samplesAt(reader, source.path);
  if (samples === null) return { present: reader.exists(source.path), recordsInWindow: 0 };
  const inWindow = samples.filter((sample) => {
    const at = Date.parse(sample.at);
    return at >= window.from && at <= window.to;
  });
  return { present: true, recordsInWindow: inWindow.length };
}

/** The moments of the samples in a metrics file. */
function samplesAt(reader: RecordReader, path: string): { at: string }[] | null {
  if (path.startsWith(`${LAYOUT.awsMetricsDir}/`)) {
    return reader.read(path, metricSeriesRecords)?.flatMap((one) => one.points) ?? null;
  }
  if (path === LAYOUT.hostSamples) return reader.read(path, hostSampleRecords);
  throw new Error(`${path} is not a metrics file the archive knows`);
}

/** The record kind of each file a run holds, by where it sits; logs and the like hold none. */
function kindOfPath(path: string) {
  if (path.startsWith('requests/')) return requestRecords;
  if (path.startsWith(`${LAYOUT.awsMetricsDir}/`)) return metricSeriesRecords;
  if (path.endsWith('.state.jsonl')) return stateRecords;
  const byPath: Record<string, RecordKind<z.ZodType>> = {
    [LAYOUT.hostSamples]: hostSampleRecords,
    [LAYOUT.events]: eventRecords,
    [LAYOUT.awsEvents]: awsEventRecords,
    [LAYOUT.insights]: insightRecords,
    [LAYOUT.exchanges]: exchangeRecords,
    [LAYOUT.jobs]: jobRecords,
    [LAYOUT.appRequests]: appRequestRecords,
    [LAYOUT.appState]: appStateRecords,
  };
  return byPath[path] ?? null;
}

/**
 * Reads the run's record files, each validated against its schema. A file
 * that does not validate becomes a finding, once, and reads as null.
 */
function createRecordReader(folder: string, findings: Finding[]) {
  const checked = new Set<string>();
  const failed = (path: string, error: unknown): null => {
    const reason = error instanceof Error ? error.message : String(error);
    findings.push({ check: 'records-valid', detail: `${path}: ${reason}`, path });
    return null;
  };
  return {
    exists: (path: string): boolean => existsSync(join(folder, path)),
    read<Schema extends z.ZodType>(
      path: string,
      kind: RecordKind<Schema>,
    ): z.infer<Schema>[] | null {
      const file = join(folder, path);
      if (!existsSync(file)) return null;
      checked.add(path);
      try {
        return kind.readLines(readFileSync(file, 'utf8'));
      } catch (error) {
        return failed(path, error);
      }
    },
    readReport(path: string): Report | null {
      const file = join(folder, path);
      if (!existsSync(file)) return null;
      checked.add(path);
      try {
        return reportRecords.read(JSON.parse(readFileSync(file, 'utf8')));
      } catch (error) {
        return failed(path, error);
      }
    },
    /**
     * Goes through the records of a file one at a time, each validated against
     * the kind's schema, with the memory of one line however big the file is.
     * Resolves to whether the file was there and valid. A file that is not valid
     * becomes a finding, once.
     */
    async scan<Item>(
      path: string,
      kind: { readLine: (line: string, number: number) => Item | null },
      visit: (record: Item) => void,
    ): Promise<boolean> {
      const file = join(folder, path);
      if (!existsSync(file)) return false;
      checked.add(path);
      try {
        let number = 0;
        for await (const { text } of linesOfFile(file)) {
          number += 1;
          const record = kind.readLine(text, number);
          if (record !== null) visit(record);
        }
        return true;
      } catch (error) {
        failed(path, error);
        return false;
      }
    },
    /** Reads a file by what its place in the run says it holds; files that hold no records are left alone. */
    async readByPlace(path: string): Promise<void> {
      const nothing = (): void => undefined;
      if (path.endsWith('.report.json')) {
        this.readReport(path);
        return;
      }
      const kind = kindOfPath(path);
      if (kind !== null) await this.scan(path, kind, nothing);
    },
    /** Validates every file not yet read, so that no record file goes unchecked. */
    async checkTheRest(): Promise<void> {
      for (const path of listRunFiles(folder).filter((file) => !checked.has(file))) {
        await this.readByPlace(path);
      }
    },
  };
}
