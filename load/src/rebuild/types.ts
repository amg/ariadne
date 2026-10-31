import type { AppRequestLine, AppStateLine, ExchangeLine, JobLine } from '../records/appRecords.ts';
import type { AwsEvent, Insight, MetricSeries } from '../records/awsRecords.ts';
import type { RunEvent } from '../records/event.ts';
import type { DownWindow, Manifest, ManifestSlice } from '../records/manifest.ts';
import type { RequestKind, RequestLine, StateLine } from '../records/request.ts';
import type { HostSample } from '../records/samples.ts';
import type { Judgement, Limits, RunFigures } from '../types/criteria.ts';
import type { Distribution } from './numbers.ts';

/**
 * What the system did in the stretch after the run's end: the records the
 * backend kept then. The stretch is drawn and never judged.
 */
export type AfterRun = AppRecords & {
  /** Where the stretch starts, which is the end of the run. */
  from: string;
  /** Where the stretch ends. */
  to: string;
};

/** The backend's records of exchanges, jobs, requests and state. */
export type AppRecords = {
  exchanges: readonly ExchangeLine[] | null;
  jobs: readonly JobLine[] | null;
  appRequests: readonly AppRequestLine[] | null;
  appStates: readonly AppStateLine[] | null;
};

/** A file the manifest lists that cannot be used as it is, and why. */
export type Trouble = { path: string; reason: string };

/** What one slice of users left, whichever generators held it. A part is null where its file is missing or unusable. */
export type SliceData = {
  slice: ManifestSlice;
  requests: readonly RequestLine[] | null;
  states: readonly StateLine[] | null;
};

/** The CloudWatch metrics of one resource of the raise, as the run kept them. */
export type ResourceMetrics = {
  /** Names the resource as its file is named, such as `ecs-service-api`. */
  resource: string;
  /** The file the metrics were read from. */
  path: string;
  series: readonly MetricSeries[];
};

/** Everything a run folder holds, read and validated. A source is null where its file is missing or unusable. */
export type RunData = {
  manifest: Manifest;
  events: readonly RunEvent[] | null;
  slices: readonly SliceData[];
  host: readonly HostSample[] | null;
  exchanges: readonly ExchangeLine[] | null;
  jobs: readonly JobLine[] | null;
  /** What the API recorded of each request it answered; null where the run folder holds no such file. */
  appRequests: readonly AppRequestLine[] | null;
  appStates: readonly AppStateLine[] | null;
  /** The backend's records of the stretch after the run's end; null for a run that kept none. Never judged. */
  afterRun: AfterRun | null;
  /** The database's busiest waits and queries, minute by minute. */
  insights: readonly Insight[] | null;
  /** The CloudWatch metrics of every resource whose file is there and usable; empty for a run that kept none. */
  awsMetrics: readonly ResourceMetrics[];
  /** What AWS recorded about the raise. */
  awsEvents: readonly AwsEvent[] | null;
  /** Files the manifest lists that are gone, changed since the run was sealed, or not valid. */
  trouble: readonly Trouble[];
};

/** A window in which a source recorded nothing it should have. A gap is named, never filled. */
export type Gap = {
  source: string;
  from: string;
  to: string;
  reason: string;
};

/** What one slice of users did over the whole run, whichever generators held it. */
export type SliceSummary = {
  generator: number;
  firstUser: number;
  lastUser: number;
  requests: number;
  failedRequests: number;
  chatsStreamed: number;
  /** Every window the slice was down, oldest first. */
  down: readonly DownWindow[];
  /** How long the slice was down, over the run. */
  downSeconds: number;
};

/** How many chats streamed a reply, and how many the gate paused. */
export type ChatCount = { streamed: number; paused: number };

/**
 * What the generators and the API each counted of the run's chats, outside
 * every window a slice was down, for the two to be set against each other.
 */
type ChatCounts = {
  /** Null where some slice's request lines are missing. */
  generators: ChatCount | null;
  /** Null where the API's exchange lines are missing. */
  api: ChatCount | null;
  /** How many chats and exchanges were left out as inside a window a slice was down. */
  leftOut: { chats: number; exchanges: number };
};

/** How many requests of one kind failed in one way: the status the server answered with, and the error code it gave. */
export type FailureCount = {
  kind: RequestKind;
  /** Null where no response arrived. */
  status: number | null;
  /** Null where the failure carried no code. */
  errorCode: string | null;
  count: number;
};

/** The guard line that stopped a run, and the window the run lost to it. */
type GuardStop = {
  line: string;
  message: string;
  observed: number;
  limit: number;
  /** When the line was crossed. */
  from: string;
  /** When the plan would have ended, or when the run did, whichever is later. */
  to: string;
};

export type Cell = number | null;

/**
 * A figure split by something, such as by service or by kind of failure,
 * becomes one column for each value. `source` names the file that value
 * is read from, where the values do not all share one.
 */
export type Split = { figure: string; value: string; source: string | null };

/** One series of the run, a figure per minute; `of` names the figure it is one value of, when the figure is split. */
export type SeriesColumn = { name: string; values: readonly Cell[]; of: Split | null };

/** The run at one-minute resolution: each series has one figure per minute. */
export type MinuteTable = {
  /** Where each minute starts, in milliseconds, oldest first. */
  minutes: readonly number[];
  /** Where the minutes after the run's end start, which are drawn and never judged; null for a run that kept none. */
  afterRunFrom: number | null;
  columns: readonly SeriesColumn[];
};

/** The fewest of something the generators held together, and the first moment they held that few. */
export type Fewest = { count: number; at: string };

/** What the generators held, and what their users saw, while every slice held its users together. */
export type HoldFacts = {
  from: string;
  to: string;
  fewestPushStreams: Fewest | null;
  fewestChatters: Fewest | null;
  /** The chats that started in the hold and streamed a reply. */
  chatsStreamed: number;
  /** Chat first byte p95 of those chats alone; null when there were none. */
  chatFirstByteP95Ms: number | null;
};

/** The database's busiest waits and queries over the run, busiest first. */
export type InsightsSummary = {
  waits: WaitLoad[];
  queries: QueryLoad[];
  /**
   * The statements behind each wait the run kept them for, busiest wait
   * first; null for a run that kept none. A wait it did not keep them for
   * is left out, rather than shown with none.
   */
  statementsByWait: StatementsInWait[] | null;
};

type WaitLoad = Load & { wait: string; type: string | null };

/** How many sessions one wait or query held over the run: on average, and at most. */
export type Load = { meanSessions: number; peakSessions: number };

export type QueryLoad = Load & { statement: string; id: string | null };

/** The busiest statements behind one wait, busiest first. */
type StatementsInWait = { wait: string; statements: QueryLoad[] };

/** A moment the charts mark on their time axis, and what happened then. */
export type Marker = { at: string; what: string };

export type Summary = {
  requests: {
    total: number;
    byKind: Record<string, KindSummary>;
    /**
     * Failed requests, counted by kind, status and the error code the server
     * gave. A push stream cut off and reopened within seconds is counted
     * under `pushStreams` instead.
     */
    failures: FailureCount[];
  };
  /** The generators' push streams that opened, and those that ended before their users let them go. */
  pushStreams: {
    opened: number;
    /** Streams that ended before their users let them go: closed or cut off by the server or something between. */
    endedEarly: number;
    /** Of those, the streams that broke off rather than closing cleanly. */
    cut: number;
    /** Of those, the streams whose users opened another within `reopenedWithinSeconds`. */
    reopened: number;
    reopenedWithinSeconds: number;
    /** The minute the most streams ended early in, and how many; null when none did. */
    mostEndedInAMinute: { minute: string; count: number } | null;
  };
  /** The most users the generators held in any one minute, as `usersByMinute` adds them up. */
  users: { peakSignedIn: number; peakPushStreams: number; peakChatters: number };
  app: {
    exchanges: {
      count: number;
      byOutcome: Record<string, number>;
      byVerdict: Record<string, number>;
      verdictMs: Distribution | null;
      firstTokenMs: Distribution | null;
      endedMs: Distribution | null;
    } | null;
    jobs: {
      count: number;
      byTask: Record<
        string,
        { count: number; failed: number; waitMs: Distribution | null; runMs: Distribution | null }
      >;
    } | null;
    /** What the API recorded of the requests it answered; null for a run that kept none. */
    requests: {
      count: number;
      serverMs: Distribution | null;
      /** By route pattern; a request no route took is counted under `no route`. */
      byRoute: Record<
        string,
        { count: number; serverErrors: number; serverMs: Distribution | null }
      >;
    } | null;
    peakPushStreams: number | null;
    longestJobWaitMs: number | null;
    /** The worst of each figure any copy gave in any state line; null where no copy measured it. */
    copies: CopyPeaks;
    /** The worst of each figure each copy gave, by the copy's label, such as `api-8536ff1a`. */
    byCopy: Record<
      string,
      CopyPeaks & {
        copy: string | null;
        peakPushStreams: number | null;
        longestJobWaitMs: number | null;
      }
    >;
  };
  host: {
    samples: number;
    cpuPercent: { mean: number; max: number } | null;
    memoryUsedPercentMax: number | null;
    swapUsedBytesMax: number | null;
    loadAverage1Max: number | null;
  };
  /** The database's busiest waits and queries; null for a run that kept no Performance Insights. */
  insights: InsightsSummary | null;
};

type KindSummary = {
  count: number;
  byOutcome: Record<string, number>;
  /** Timings of the requests that did their job: those that were served. */
  firstByteMs: Distribution | null;
  totalMs: Distribution | null;
};

/** The worst of each figure a copy gave in any state line; null where it did not measure it. */
type CopyPeaks = {
  longestEventLoopDelayMs: number | null;
  peakHeapUsedBytes: number | null;
  peakResidentBytes: number | null;
  peakDbConnectionsInUse: number | null;
  peakDbConnectionsWaiting: number | null;
  peakWorkerSlotsBusy: number | null;
  workerSlots: number | null;
  pushBusFailures: number | null;
};

/** One moment of the run, and what happened then, in one line. */
export type TimelineEntry = { at: string; text: string };

/**
 * What a rebuild reads off a run's records once, beside its minute table:
 * what the run was, how it ended, and the counts, windows and figures that
 * judging and the report need. Nothing that reads them goes back to the
 * records.
 */
export type RunFacts = {
  run: Pick<
    Manifest,
    'runId' | 'step' | 'target' | 'loadPath' | 'startedAt' | 'endedAt' | 'seal'
  > & {
    /** The limits the run recorded when it began; null for a step that had none. */
    limits: Limits | null;
    /** The ECPU a second the step allowed the cache; null where its configuration does not say. */
    cacheEcpuCap: number | null;
  };
  /** How the run ended; null when it never recorded its end. */
  outcome: RunOutcome | null;
  /** Every slice of users, with the windows it was down and what its users did. */
  slices: readonly SliceSummary[];
  guardStop: GuardStop | null;
  gaps: readonly Gap[];
  /** Files the manifest lists that are gone, changed since the run was sealed, or not valid. */
  trouble: readonly Trouble[];
  /** What the pass criteria judge the run by. */
  figures: RunFigures;
  /** The hold alone; null for a run that records none. */
  hold: HoldFacts | null;
  chats: ChatCounts;
  /** Whether every slice's request lines could be read. */
  requestLinesWhole: boolean;
  /** The whole minutes in which the generators carried the run's load, each as the millisecond it starts. */
  loadMinutes: readonly number[];
  summary: Summary;
  timeline: readonly TimelineEntry[];
  /** The moments the charts mark. */
  markers: readonly Marker[];
};

/** How a run ended, as it recorded its end. */
type RunOutcome = Extract<RunEvent, { kind: 'run-ended' }>['outcome'];

/** One count of the generators set against the same count in another record of the run. */
export type CrossCheck = {
  what: string;
  /** The record the generators are set against, such as the API's exchange lines. */
  against: string;
  generators: number | null;
  /** The same count in the other record; null when the check could not be made. */
  other: number | null;
  /**
   * `not-made` is a check the run needed and could not make, and it keeps the
   * run from passing. `not-needed` is a check this kind of run never makes.
   */
  result: 'agree' | 'mismatch' | 'not-made' | 'not-needed';
  /** Why the check was not made or not needed, or how far apart the counts are, and what was left out of the counts. */
  detail: string;
};

/**
 * How a run came out. `fail` means a pass criterion was missed or the
 * guard stopped the run on one. `incomplete` means nothing was missed but
 * the run cannot be called a pass, because something it needs is missing,
 * unreadable, or at odds with another record.
 */
export type Verdict = 'pass' | 'fail' | 'incomplete';

/** Something that stands between a run and a pass. */
export type Reason =
  | { kind: 'criterion-missed'; judgement: Judgement; observed: number }
  | { kind: 'criterion-not-judged'; title: string }
  | { kind: 'criteria-unknown'; why: string }
  | { kind: 'guard-stopped'; message: string }
  | { kind: 'sealed-incomplete'; findings: number }
  | { kind: 'file-unusable'; path: string; why: string }
  | { kind: 'records-disagree'; what: string; against: string }
  | { kind: 'cross-check-not-made'; against: string; why: string }
  | { kind: 'never-ended' }
  | { kind: 'ended-early'; outcome: string };
