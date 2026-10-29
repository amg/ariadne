import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AWS_METRIC_RESOURCES,
  type AwsEvent,
  type Finding,
  LAYOUT,
  type RunEvent,
} from '../../records/index.ts';
import type { TaskInfo } from '../../types/archive.ts';
import { attemptsBySlice } from '../attempts.ts';
import { collectAppRecords, collectSliceOutput, jsonLines, linesOf } from '../collect.ts';
import { PARTIAL } from '../files.ts';
import type { CollectContext, CollectionContext, sealRun } from '../sealRun.ts';
import { keptFindings } from './keptFindings.ts';
import { keptGeneratorTasks, withKeptTasks } from './keptTasks.ts';
import { awaitMetricsUntil } from './metricsWait.ts';
import { compareText } from './order.ts';
import { type Raise, keptAppLogGroupsOf, metricTargetsOf, unavailable } from './raise.ts';
import { outcomeOfGenerators, runEventsOf, taskStopEventsOf } from './runEvents.ts';
import { type LogEvent, type RaiseSources, SourceUnavailable } from './sources.ts';

type WaitForMetrics = Parameters<typeof awaitMetricsUntil>[0]['wait'];

type Collection = Parameters<typeof sealRun>[0]['collection'];

/**
 * How long after a run's end the raise's logs, metrics and app records are
 * still collected: the system goes on draining after the load stops.
 */
const TRAILING_MS = 5 * 60_000;

/** When the stretch after a run's end, which the archive also collects, ends. */
export function trailingEndOf(endedAt: string) {
  return new Date(Date.parse(endedAt) + TRAILING_MS).toISOString();
}

type AwsRunInput = {
  runId: string;
  raise: Raise;
  startedAt: string;
  endedAt: string;
  /** How the run ended; worked out from how its generators stopped when not given. */
  outcome?: Extract<RunEvent, { kind: 'run-ended' }>['outcome'];
  /** The seconds a generator ramps and holds, from the step's configuration. */
  plan: { rampSeconds: number; holdSeconds: number };
};

/**
 * The windows of an archive: what the run did, the run with the stretch
 * after it, and the whole raise the run was part of with that stretch.
 */
function windowsOf(input: Pick<AwsRunInput, 'raise' | 'startedAt' | 'endedAt'>) {
  const to = new Date(trailingEndOf(input.endedAt));
  return {
    run: { from: new Date(input.startedAt), to: new Date(input.endedAt) },
    runAndAfter: { from: new Date(input.startedAt), to },
    raise: { from: new Date(input.raise.startedAt), to },
  };
}

/** Where a generator attempt's unsorted log goes until the archive has sorted it. */
const generatorStreamOf = (taskId: string) => `generator/generator/${taskId}`;

/** Writes the lines of each batch into a file, one batch after another, which takes its place only once all are written. */
async function writeBatchesAtomically(file: string, batches: AsyncIterable<readonly string[]>) {
  const partial = `${file}${PARTIAL}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(partial, '');
  for await (const batch of batches) appendFileSync(partial, linesOf(batch));
  renameSync(partial, file);
}

/** Orders events by when they happened, then by what they are, so that the same events always read the same. */
function sortedEvents(events: readonly AwsEvent[]) {
  const key = (event: AwsEvent): string =>
    `${event.at}|${event.source}|${event.resource}|${event.summary}`;
  return [...events].sort((a, b) => compareText(key(a), key(b)));
}

/**
 * Collects a run on aws-prod: its generators' logs, the logs of the
 * services worth reading in an incident, every CloudWatch metric of the
 * raise, the database's Performance Insights and what AWS recorded of the
 * raise's services and tasks. A source whose resource is gone becomes a
 * finding, which seals the run as incomplete; any other failure stops the
 * archive, to be resumed. A file already collected is not collected again.
 * A source that is gone leaves no file, so a resumed archive asks for it
 * again. The two files written from what remains have their findings kept.
 *
 * The raise's logs and metrics are kept whole, but the backend's records
 * are those of this run alone, because a raise may carry several runs.
 */
export function awsCollection(input: {
  folder: string;
  run: AwsRunInput;
  sources: RaiseSources;
  /** How long to wait for the figures of the stretch after the run, which CloudWatch delivers late. */
  waitForDelivery: WaitForMetrics;
  /** The time; the clock unless a test says otherwise. */
  now?: () => Date;
  /** Keeps findings about a file of the run safe for a later archive; resolves once they are. */
  keepFindings: (file: string, findings: readonly Finding[]) => void;
}): Collection {
  const { folder, run, sources } = input;
  const { raise } = run;
  const windows = windowsOf(run);
  const has = (path: string): boolean => existsSync(join(folder, path));

  // The findings of this collection, which only it adds to.
  const found: Finding[] = [];
  const takeFindings = (): readonly Finding[] => found.splice(0);

  // Findings about files an earlier attempt at this archive left; files collected now carry their own.
  const inherited = keptFindings(folder);
  const keptNow: Finding[] = [];
  const keep = (file: string, findings: readonly Finding[]): void => {
    keptNow.push(...findings);
    input.keepFindings(file, findings);
  };

  /** Every finding of the archive so far, including those of an earlier attempt at it, each once. */
  const allFindings = (): readonly Finding[] => {
    const all = [...inherited, ...keptNow, ...takeFindings()];
    return all.filter(
      (finding, index) =>
        all.findIndex((other) => JSON.stringify(other) === JSON.stringify(finding)) === index,
    );
  };

  /** Reads a source of the raise; one whose resource is gone is recorded and read as nothing. */
  const orNothing = async <Result>(
    what: string,
    read: () => Promise<Result>,
  ): Promise<Result | null> => {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof SourceUnavailable)) throw error;
      found.push(unavailable(what, error.message));
      return null;
    }
  };

  /**
   * The generators' tasks, asked for once, and only when something needs
   * them: those ECS still describes, and those the run kept as they stopped.
   */
  let generatorTasks: Promise<readonly TaskInfo[]> | null = null;
  const tasksOfGenerators = (): Promise<readonly TaskInfo[]> => {
    generatorTasks ??= orNothing('the generators’ tasks', () =>
      sources.tasks(raise.clusters.load),
    ).then((tasks) =>
      withKeptTasks({ live: tasks ?? [], kept: keptGeneratorTasks(folder), runId: run.runId }),
    );
    return generatorTasks;
  };

  return {
    async prepare({ put }) {
      if (!has(LAYOUT.events)) {
        const tasks = await tasksOfGenerators();
        keep(LAYOUT.events, takeFindings());
        const events = runEventsOf({
          ...run,
          outcome: run.outcome ?? outcomeOfGenerators(tasks),
          tasks,
        });
        put(LAYOUT.events, jsonLines(events));
      }
      return [];
    },

    async collect(context) {
      await awaitTrailingMetrics();
      await collectGeneratorLogs(context);
      await collectLogGroups(context);
      await collectAppRecords(folder, ['api', 'worker'], context, windows.runAndAfter);
      await collectMetrics(context);
      await collectAwsEvents(context);
      await collectDatabase(context);
      return allFindings();
    },
  };

  /**
   * CloudWatch is slow to deliver the minutes after the run, so the archive
   * waits until one of the app's services has its figures for the end of the
   * stretch. A raise without services, or one that is gone, is not waited for.
   * Metrics of a raise that is gone are reported by their own collection.
   */
  async function awaitTrailingMetrics() {
    const service = raise.services[0];
    if (service === undefined) return;
    const probe = metricTargetsOf(raise).find(
      ({ label }) => label === AWS_METRIC_RESOURCES.service(service.label),
    );
    if (probe === undefined) return;
    try {
      await awaitMetricsUntil({
        metrics: sources.metricSeries,
        probe,
        until: windows.runAndAfter.to,
        wait: input.waitForDelivery,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    } catch (error) {
      if (!(error instanceof SourceUnavailable)) throw error;
    }
  }

  async function collectGeneratorLogs(context: CollectContext) {
    const group = raise.logGroups.find((candidate) => candidate.stack === 'load');
    for (const { generator, attempt, task } of context.attempts) {
      const out = join(folder, LAYOUT.generatorOutput(generator, attempt));
      if (group === undefined || has(LAYOUT.generatorLog(generator, attempt)) || existsSync(out)) {
        continue;
      }
      const lines = messagesOf(
        sources.logMessages(group.name, generatorStreamOf(task), windows.raise),
      );
      await orNothing(`the log of generator ${generator} attempt ${attempt}`, () =>
        writeBatchesAtomically(out, lines),
      );
    }
    for (const slice of attemptsBySlice(context.attempts)) {
      const tries = slice.attempts.map(({ attempt }) => attempt);
      await collectSliceOutput(folder, slice.generator, tries, context);
    }
  }

  async function collectLogGroups({ putFrom }: CollectionContext) {
    for (const group of keptAppLogGroupsOf(raise)) {
      const path = LAYOUT.processLog(group.label);
      if (has(path)) continue;
      const streams = await orNothing(`the log group ${group.label}`, () =>
        sources.logStreams(group.name, windows.raise),
      );
      if (streams === null) continue;
      await putFrom(path, async (partial) => {
        const messages = streams.map((stream) =>
          stampedLinesOf(stream, sources.logMessages(group.name, stream, windows.raise)),
        );
        await writeBatchesAtomically(partial, concatenated(messages));
      });
    }
  }

  async function collectMetrics({ put }: CollectionContext) {
    for (const target of metricTargetsOf(raise)) {
      const path = LAYOUT.awsMetrics(target.label);
      if (has(path)) continue;
      const series = await orNothing(`the metrics of ${target.label}`, () =>
        sources.metricSeries(target, windows.raise),
      );
      if (series !== null && series.length > 0) put(path, jsonLines(series));
    }
  }

  async function collectAwsEvents({ put }: CollectionContext) {
    if (has(LAYOUT.awsEvents)) return;
    const foundBefore = found.length;
    const services = raise.services.map((service) => service.name);
    const appTasks = await orNothing('the app cluster’s tasks', () =>
      sources.tasks(raise.clusters.app),
    );
    const parts: (readonly AwsEvent[] | null)[] = [
      await orNothing('the services’ events', () =>
        sources.serviceEvents(raise.clusters.app, services),
      ),
      await orNothing('the scaling activity', () =>
        sources.scalingActivity(raise.clusters.app, services),
      ),
      taskStopEventsOf([...(appTasks ?? []), ...(await tasksOfGenerators())]),
    ];
    keep(LAYOUT.awsEvents, found.splice(foundBefore));
    put(LAYOUT.awsEvents, jsonLines(sortedEvents(parts.flatMap((part) => part ?? []))));
  }

  async function collectDatabase({ put }: CollectionContext) {
    const { resourceId } = raise.database;
    if (resourceId === null) {
      found.push(
        unavailable('the database’s Performance Insights', 'its resource id was not known'),
      );
      return;
    }
    if (has(LAYOUT.insights)) return;
    const insights = await orNothing('the database’s Performance Insights', () =>
      sources.databaseInsights(resourceId, windows.raise),
    );
    if (insights !== null) put(LAYOUT.insights, jsonLines(insights));
  }
}

/** Several streams of batches read one after another as one. */
async function* concatenated(
  streams: readonly AsyncIterable<readonly string[]>[],
): AsyncIterable<readonly string[]> {
  for (const stream of streams) yield* stream;
}

/** The messages alone, as the process printed them. */
async function* messagesOf(
  batches: AsyncIterable<readonly LogEvent[]>,
): AsyncIterable<readonly string[]> {
  for await (const batch of batches) yield batch.map((event) => event.message);
}

/**
 * Each message after when it was logged and the stream it came from, as
 * `aws logs tail` prints it, so the log of a service with many tasks can be
 * read task by task.
 */
async function* stampedLinesOf(
  stream: string,
  batches: AsyncIterable<readonly LogEvent[]>,
): AsyncIterable<readonly string[]> {
  for await (const batch of batches) {
    yield batch.map((event) => `${event.at} ${stream} ${event.message}`);
  }
}
