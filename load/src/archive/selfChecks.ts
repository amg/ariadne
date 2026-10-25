import { z } from 'zod';
import {
  type FileEntry,
  type Finding,
  LAYOUT,
  REQUEST_KINDS,
  type Report,
  type RequestKind,
} from '../records/index.ts';
import type { Attempt } from './attempts.ts';

/**
 * How far a generator's first or last request may sit from the edge of
 * its window. The first user needs a moment to sign in, and the last
 * requests end as the users wind down.
 */
const EDGE_TOLERANCE_MS = 15_000;

/** The request lines one generator attempt wrote into its slice's file. */
export type RequestFacts = {
  /** Whether the slice's file of request lines exists at all. */
  present: boolean;
  count: number;
  byKind: Partial<Record<RequestKind, number>>;
  /** The earliest request's start; null with no lines. */
  firstStartedAt: string | null;
  /** The moment the latest-ending request ended; null with no lines. */
  lastEndedAt: string | null;
};

export type AttemptFacts = {
  attempt: Attempt;
  requests: RequestFacts;
  /** The attempt's final report; null where it never lived to print one. */
  report: Report | null;
  /** The path of its slice's request lines, which its own lines belong in. */
  requestsPath: string;
};

/**
 * Every attempt needs request lines that cover its window. The window is
 * the plan as the attempt's own report says it ran, from the ramp's start
 * to the ramp-down's end. An attempt with no such report falls back to
 * its task's life, from launch to stop. A missing file fails, and so does
 * an attempt that had users but wrote no lines, unless it was cut off and
 * its events say why it stopped. A first request long after the window
 * opened fails too. An attempt that finished its plan must also have its
 * last request end near the window's close. An attempt stopped early is
 * excused at the close, because it lost the streams it had open and its
 * events say why it stopped.
 */
export function checkRequestCoverage(attempts: readonly AttemptFacts[]) {
  return attempts.flatMap(coverageFindings);
}

function coverageFindings({ attempt, requests, report, requestsPath }: AttemptFacts) {
  const name = `generator ${attempt.generator} attempt ${attempt.attempt}`;
  const finding = (detail: string): Finding => ({
    check: 'request-coverage',
    detail: `${name}: ${detail}`,
    path: requestsPath,
  });
  if (!requests.present) return [finding(`${requestsPath} is missing`)];
  if (requests.count === 0) {
    const cutOff = attempt.stoppedBecause !== 'finished' && attempt.stoppedBecause !== null;
    return attempt.userCount > 0 && !cutOff
      ? [finding('no request lines, though it had users')]
      : [];
  }
  const window = windowOf(attempt, report);
  const late = lateStart(requests, window);
  const early = earlyEnd(attempt, requests, window);
  return [
    ...(late === null
      ? []
      : [finding(`its first request came ${late} ms after its window opened`)]),
    ...(early === null
      ? []
      : [finding(`its last request ended ${early} ms before its window closed`)]),
  ];
}

/**
 * When an attempt was meant to be sending requests: its plan as its report
 * says it ran, or else its task's life. Start-up before the plan and
 * shutdown after it send nothing, so they are not part of the window.
 */
function windowOf(attempt: Attempt, report: Report | null) {
  const phases = report?.phases ?? null;
  return phases === null
    ? { opened: attempt.startedAt, closed: attempt.stoppedAt }
    : { opened: phases.ramp.startedAt, closed: phases.rampDown.endedAt };
}

/** How long after its window opened an attempt's first request came, when that is too long. */
function lateStart(requests: RequestFacts, window: { opened: string }) {
  const opened = Date.parse(window.opened);
  const first = Date.parse(requests.firstStartedAt ?? window.opened);
  const late = first - opened;
  return late > EDGE_TOLERANCE_MS ? late : null;
}

/** How long before its window closed an attempt's last request ended, when that is too long and nothing excuses it. */
function earlyEnd(attempt: Attempt, requests: RequestFacts, window: { closed: string | null }) {
  if (attempt.stoppedBecause !== 'finished' || window.closed === null) return null;
  const closed = Date.parse(window.closed);
  const last = Date.parse(requests.lastEndedAt ?? window.closed);
  const early = closed - last;
  return early > EDGE_TOLERANCE_MS ? early : null;
}

/**
 * A run must have launched at least one generator. With none, nothing
 * was asked of the app, and a run with no requests to judge would pass.
 */
export function checkGeneratorsRan(generatorCount: number): Finding[] {
  if (generatorCount > 0) return [];
  return [
    {
      check: 'request-coverage',
      detail: 'no generator task was found, so the run put no load on the app',
      path: LAYOUT.events,
    },
  ];
}

/**
 * Where an attempt lived to print its final report, the request lines
 * found must be as many as the report says it wrote, in all and by kind.
 */
export function checkRequestTotals(attempts: readonly AttemptFacts[]) {
  return attempts.flatMap(({ attempt, requests, report, requestsPath }) => {
    if (report === null || !requests.present) return [];
    const name = `generator ${attempt.generator} attempt ${attempt.attempt}`;
    const found: Finding[] = [];
    if (report.requests.total !== requests.count) {
      found.push({
        check: 'request-totals',
        detail: `${name} reports ${report.requests.total} requests; ${requests.count} lines were found`,
        path: requestsPath,
      });
    }
    for (const kind of REQUEST_KINDS) {
      const reported = report.requests.byKind[kind] ?? 0;
      const counted = requests.byKind[kind] ?? 0;
      if (reported !== counted) {
        found.push({
          check: 'request-totals',
          detail: `${name} reports ${reported} ${kind} requests; ${counted} lines were found`,
          path: requestsPath,
        });
      }
    }
    return found;
  });
}

/**
 * A source the run was expected to leave: a service's logs, or its metrics.
 */
export const expectedSourceSchema = z.discriminatedUnion('kind', [
  z.object({ service: z.string(), kind: z.literal('logs'), path: z.string() }),
  z.object({ service: z.string(), kind: z.literal('metrics'), path: z.string() }),
]);
export type ExpectedSource = z.infer<typeof expectedSourceSchema>;

/** What was found of an expected source. `recordsInWindow` is null for logs, whose lines are not timed. */
type SourceFacts = { present: boolean; recordsInWindow: number | null };

/** Every expected service must have left its logs, and its metrics with at least one record inside the run's window. */
export function checkServicesRecorded(
  expected: readonly ExpectedSource[],
  factsOf: (source: ExpectedSource) => SourceFacts,
) {
  return expected.flatMap((source) => {
    const facts = factsOf(source);
    const finding = (detail: string): Finding => ({
      check: 'services-recorded',
      detail: `${source.service}: ${detail}`,
      path: source.path,
    });
    if (!facts.present) return [finding(`its ${source.kind} are missing (${source.path})`)];
    if (facts.recordsInWindow === 0) {
      return [finding(`its ${source.kind} hold no record inside the run's window`)];
    }
    return [];
  });
}

/**
 * What the backend's own records show for the run. Each is null where its
 * file is missing.
 */
type AppRecordFacts = {
  /** How many exchange lines there are, and how many of them are of replies that began streaming. */
  exchanges: { count: number; streamed: number } | null;
  /** How many job lines there are. */
  jobs: number | null;
  /** How many state lines there are. */
  states: number | null;
  /** How many chats the generators saw stream a reply. */
  chatsStreamed: number;
};

/**
 * The backend must have left all three kinds of record. Every chat the
 * generators saw stream was a reply the API began, so the API must have
 * written at least as many exchange lines of replies that streamed. Each
 * streamed reply leaves jobs behind, so the worker must have written
 * some. A copy writes its state at once and every few seconds, so a
 * backend that ran has written some too.
 */
export function checkAppRecords(facts: AppRecordFacts) {
  const finding = (detail: string, path: string): Finding => ({
    check: 'app-records',
    detail,
    path,
  });
  const files = [
    { what: 'exchange lines', path: LAYOUT.exchanges, found: facts.exchanges },
    { what: 'job lines', path: LAYOUT.jobs, found: facts.jobs },
    { what: 'state lines', path: LAYOUT.appState, found: facts.states },
  ];
  const missing = files
    .filter(({ found }) => found === null)
    .map(({ what, path }) => finding(`the backend's ${what} are missing (${path})`, path));
  if (missing.length > 0) return missing;

  const found: Finding[] = [];
  if (facts.states === 0) {
    found.push(finding('the backend wrote no state line', LAYOUT.appState));
  }
  const streamed = facts.exchanges?.streamed ?? 0;
  if (streamed < facts.chatsStreamed) {
    found.push(
      finding(
        `the generators saw ${facts.chatsStreamed} chats stream; the API wrote ${streamed} exchange lines of replies that streamed`,
        LAYOUT.exchanges,
      ),
    );
  }
  if (facts.chatsStreamed > 0 && facts.jobs === 0) {
    found.push(
      finding(
        `the backend wrote no job line, though ${facts.chatsStreamed} chats streamed`,
        LAYOUT.jobs,
      ),
    );
  }
  return found;
}

/** Every file the manifest lists must still hold what was written: same size, same checksum. */
export function checkChecksums(
  listed: readonly FileEntry[],
  actualOf: (path: string) => FileEntry | null,
) {
  return listed.flatMap((entry) => {
    const actual = actualOf(entry.path);
    const finding = (detail: string): Finding => ({
      check: 'checksums',
      detail: `${entry.path} ${detail}`,
      path: entry.path,
    });
    if (actual === null) return [finding('is gone')];
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) {
      return [finding('does not match its recorded checksum')];
    }
    return [];
  });
}
