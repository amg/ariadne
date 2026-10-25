import type { RunEvent, StopReason } from '../records/event.ts';
import type { Report } from '../records/report.ts';

/** Why a generator stopped before its plan ended: it was told to, it broke, or it outlasted its time. */
export type EarlyStop = Extract<StopReason, 'interrupted' | 'failed' | 'timed-out'>;

/** One try at running a generator's slice of the users. */
export type GeneratorStart = {
  generator: number;
  /** Which try at this slice it is; a replacement takes the next number. */
  attempt: number;
  firstUser: number;
  userCount: number;
  /** How long the generator brings its users up for, when it starts at once. */
  rampSeconds: number;
  /** How long the generator holds its users, when it starts at once. */
  holdSeconds: number;
  /**
   * When the run's stage ends, in milliseconds. A generator given one begins
   * its plan when it is ready, and ramps and holds only for the time left
   * until then, so a slow start cannot push it past the stage's end. Null
   * for a generator that runs the whole plan above.
   */
  endsAt: number | null;
  thinkSeconds: number;
  /** The longest the generator may run before it is stopped as timed out. */
  timeoutMs: number;
};

/**
 * How a generator ended. A generator that finished its plan reports so.
 * One that stopped early says why, and brings its report when it lived to
 * write one: only a generator that was told to stop does. A launcher that
 * cannot read a generator's report, because the report goes elsewhere,
 * gives none.
 */
export type GeneratorEnd =
  | { how: 'finished'; report: Report | null }
  | {
      how: 'stopped';
      reason: EarlyStop;
      detail: string;
      report: Report | null;
      /** Set when the generator could not be stopped, so it may still be loading its users. */
      mayStillRun?: boolean;
    };

/** A generator that is running. */
export type LaunchedGenerator = {
  /** What names its process or task, as the run's events record it. */
  task: string;
  /** Whether it runs on capacity that can be reclaimed. */
  spot: boolean;
  /** Settles, and never rejects, once the generator has ended. */
  ended: Promise<GeneratorEnd>;
  /** Tells the generator to stop, and resolves once it has. */
  stop: () => Promise<void>;
};

/** Starts generators wherever they run: local processes, or tasks in the cloud. */
export type GeneratorLauncher = {
  /**
   * Resolves once the generator is up, so that its plan counts from then.
   * Rejects when it could not be started at all, or was not up in good
   * time. Rejects at once when `signal` aborts. A generator that was not up
   * is stopped first.
   */
  launch: (
    start: GeneratorStart,
    signal: AbortSignal,
  ) => LaunchedGenerator | Promise<LaunchedGenerator>;
};

export type Supervision = {
  launcher: GeneratorLauncher;
  /** Aborts when the whole run must end, whatever the reason. */
  signal: AbortSignal;
  record: (event: GeneratorEvent) => void;
  /** Says what is happening, for whoever is watching the run. */
  say: (line: string) => void;
  /** Why a generator stopped because the run ended, from what ended it. */
  stopReasonOf: (cause: unknown) => { reason: StopReason; detail: string | null };
  /**
   * Whether a generator that stops early is started again on its slice;
   * true unless said otherwise. A stage that does not replace fails, and
   * stops its other generators, when one stops early.
   */
  replacesLostGenerators?: boolean;
  /** The time in milliseconds; the clock unless a test says otherwise. */
  now?: () => number;
  /** Waits for the milliseconds; a timer unless a test says otherwise. */
  sleep?: (milliseconds: number) => Promise<void>;
};

/** The events the supervision writes; each is stamped with the clock unless it carries a time. */
export type GeneratorEvent = Unstamped<
  Extract<RunEvent, { kind: 'generator-launched' | 'generator-stopped' }>
>;

type Unstamped<Event> = Event extends unknown ? Omit<Event, 'at'> & { at?: string } : never;
