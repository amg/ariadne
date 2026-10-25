import type { AppRecordKind } from '@ari/lib/api/schemas/appRecords/records';
import { type LineSink, linesOfFile } from './lines.ts';

/** Where each kind of the backend's own records is sorted to. */
type AppRecordList = 'exchanges' | 'jobs' | 'requests' | 'states';

/** The list each kind of record is sorted into; every kind the backend writes has one. */
const LISTS: Readonly<Record<AppRecordKind, AppRecordList>> = {
  exchange: 'exchanges',
  job: 'jobs',
  request: 'requests',
  state: 'states',
};

function isListedKind(kind: unknown): kind is AppRecordKind {
  return typeof kind === 'string' && Object.hasOwn(LISTS, kind);
}

/**
 * Picks the backend's exchange, job, request and state records out of its log,
 * where each sits under its own key among everything else the backend
 * said. A line may lead with when and where it was logged before the
 * backend's own JSON. A line that holds no JSON, or says something else,
 * is not a record.
 * The last line counts only when it ended in a newline: a backend that
 * was cut off may have printed half of one. Given a window, only the
 * records that happened inside it are kept. The logs are read a file and a
 * line at a time, so that logs of any size are sorted with the memory of
 * one line. Each record is written as the JSON of its fields, to the sink
 * of its list.
 */
export async function sortAppRecordsOfFiles(
  files: readonly string[],
  sinks: Readonly<Record<AppRecordList, LineSink>>,
  window: { from: Date; to: Date } | null = null,
) {
  for (const file of files) {
    for await (const { text, complete } of linesOfFile(file)) {
      if (!complete) continue;
      const record = listedRecordOrNull(text, window);
      if (record !== null) await sinks[record.list].write(record.json);
    }
  }
}

/** The record a log line holds, with the list it is sorted into and its JSON; null for a line that holds none, or none inside the window. */
function listedRecordOrNull(line: string, window: { from: Date; to: Date } | null) {
  if (!line.includes('"appRecord"')) return null;
  const record = appRecordOf(line);
  if (record === null) return null;
  const { kind, ...fields } = record;
  if (!isListedKind(kind)) return null;
  if (window !== null && !happenedIn(kind, fields, window)) return null;
  return { list: LISTS[kind], json: JSON.stringify(fields) };
}

/** The field of each kind of record that says when it happened. */
const TIME_FIELDS: Readonly<Record<AppRecordKind, string>> = {
  exchange: 'arrivedAt',
  job: 'startedAt',
  request: 'endedAt',
  state: 'at',
};

/** Whether a record happened inside the window; one that says nothing of when does not. */
function happenedIn(
  kind: AppRecordKind,
  fields: Record<string, unknown>,
  window: { from: Date; to: Date },
) {
  const time = fields[TIME_FIELDS[kind]];
  const at = typeof time === 'string' ? Date.parse(time) : Number.NaN;
  return at >= window.from.getTime() && at <= window.to.getTime();
}

function appRecordOf(line: string) {
  try {
    const parsed: unknown = JSON.parse(line.slice(line.indexOf('{')));
    if (typeof parsed !== 'object' || parsed === null || !('appRecord' in parsed)) return null;
    const { appRecord } = parsed;
    if (typeof appRecord !== 'object' || appRecord === null || Array.isArray(appRecord)) {
      return null;
    }
    return Object.fromEntries(Object.entries(appRecord));
  } catch {
    return null;
  }
}
