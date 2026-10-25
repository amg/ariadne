import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LAYOUT } from '../records/index.ts';
import { sortAppRecordsOfFiles } from './appRecords.ts';
import { reportInFile, sortGeneratorOutputFile } from './generatorOutput.ts';
import { type LineSink, lineSink } from './lines.ts';
import type { CollectionContext } from './sealRun.ts';

/** Lines of text, each ended by a newline. */
export function linesOf(lines: readonly string[]) {
  return lines.map((line) => `${line}\n`).join('');
}

/** Records as JSON Lines. */
export function jsonLines(records: readonly object[]) {
  return linesOf(records.map((record) => JSON.stringify(record)));
}

/**
 * Writes the files of a run that one pass through a big input sorts into.
 * \`files\` names each file by the sink \`work\` gets for it. The sinks are
 * closed once \`work\` is done, and when it fails, the failure of \`work\` is
 * the one that is raised.
 */
async function putSorted<Name extends string>(
  context: Pick<CollectionContext, 'putAllFrom'>,
  files: Readonly<Record<Name, string>>,
  work: (sinks: Readonly<Record<Name, LineSink>>) => Promise<void>,
): Promise<void> {
  const names = Object.keys(files) as Name[]; // Object.keys gives the keys of \`files\`, which are its names.
  await context.putAllFrom(
    names.map((name) => files[name]),
    async (partialFiles) => {
      const opened = names.map((name, index): [Name, LineSink] => [
        name,
        lineSink(partialFiles[index] ?? ''),
      ]);
      const ending = async (): Promise<void> => {
        await Promise.all(opened.map(([, sink]) => sink.end()));
      };
      try {
        await work(Object.fromEntries(opened) as Record<Name, LineSink>); // The entries pair each name with its sink.
      } catch (error) {
        await ending().catch(() => undefined);
        throw error;
      }
      await ending();
    },
  );
}

/**
 * Sorts what every attempt at running one slice printed into the slice's
 * files, a line at a time: the request lines of every attempt into one
 * file, and their state lines into another, in the order the attempts ran.
 * What else each attempt printed, and its report, stay apart as its
 * history. A slice with no output left has nothing to sort.
 */
export async function collectSliceOutput(
  folder: string,
  generator: number,
  attempts: readonly number[],
  context: Pick<CollectionContext, 'put' | 'putAllFrom'>,
) {
  const printed = attempts
    .map((attempt) => ({
      attempt,
      source: join(folder, LAYOUT.generatorOutput(generator, attempt)),
    }))
    .filter(({ source }) => existsSync(source));
  if (printed.length === 0) return;
  const logOf = (attempt: number): string => `log-${attempt}`;
  const files: Record<string, string> = {
    requests: LAYOUT.requests(generator),
    states: LAYOUT.generatorState(generator),
    ...Object.fromEntries(
      printed.map(({ attempt }) => [logOf(attempt), LAYOUT.generatorLog(generator, attempt)]),
    ),
  };
  await putSorted(context, files, async (sinks) => {
    for (const { attempt, source } of printed) {
      const rest = sinks[logOf(attempt)];
      const { requests, states } = sinks;
      if (rest === undefined || requests === undefined || states === undefined) {
        throw new Error(`the sinks of generator ${generator} attempt ${attempt} were not opened`);
      }
      await sortGeneratorOutputFile(source, { requests, states, rest });
    }
  });
  for (const { attempt, source } of printed) {
    const report = await reportInFile(source);
    if (report !== null) context.put(LAYOUT.generatorReport(generator, attempt), `${report}\n`);
  }
}

/**
 * Sorts the backend's own records out of the logs of the processes that
 * wrote them, in the order the logs are named, into their files, those
 * inside `window` when one is given. The logs are read a line at a time,
 * so a log of any size is sorted with the memory of one line. A run
 * with none of those logs gets no files, which the self-check reports.
 */
export async function collectAppRecords(
  folder: string,
  logNames: readonly string[],
  context: Pick<CollectionContext, 'putAllFrom'>,
  window: { from: Date; to: Date } | null = null,
) {
  const logs = logNames
    .map((name) => join(folder, LAYOUT.processLog(name)))
    .filter((log) => existsSync(log));
  if (logs.length === 0) return;
  await putSorted(
    context,
    {
      exchanges: LAYOUT.exchanges,
      jobs: LAYOUT.jobs,
      requests: LAYOUT.appRequests,
      states: LAYOUT.appState,
    },
    (sinks) => sortAppRecordsOfFiles(logs, sinks, window),
  );
}
