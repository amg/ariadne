import type { RunEvent, StopReason } from '../records/index.ts';

type Launched = Extract<RunEvent, { kind: 'generator-launched' }>;
type Stopped = Extract<RunEvent, { kind: 'generator-stopped' }>;

/** One generator that ran a slice of the users, as the run's events tell it. */
export type Attempt = {
  generator: number;
  /** Which try at its slice it was; a replacement takes the next number. */
  attempt: number;
  firstUser: number;
  userCount: number;
  task: string;
  spot: boolean;
  startedAt: string;
  stoppedAt: string | null;
  stoppedBecause: StopReason | null;
  stopDetail: string | null;
  /** When the generator was told to stop; null when the record does not say. */
  toldToStopAt: string | null;
  /** Whether the run's end stopped it, so that its slice ended with the run and was not lost. */
  stoppedForRunEnd: boolean;
  /** The attempt that took over its users, when one did. */
  replacedByAttempt: number | null;
  /** When its plan had the ramp and the hold end; null for a generator with no plan. */
  planned: { rampEndsAt: string; holdEndsAt: string } | null;
};

/** Every generator the events show launched, with how it stopped, in launch order. */
export function attemptsOf(events: readonly RunEvent[]) {
  const launches = events.filter((event): event is Launched => event.kind === 'generator-launched');
  const stops = events.filter((event): event is Stopped => event.kind === 'generator-stopped');
  return launches.map((launch) => {
    const stop = stops.find(
      (candidate) =>
        candidate.generator === launch.generator && candidate.attempt === launch.attempt,
    );
    return {
      generator: launch.generator,
      attempt: launch.attempt,
      firstUser: launch.firstUser,
      userCount: launch.userCount,
      task: launch.task,
      spot: launch.spot,
      startedAt: launch.at,
      stoppedAt: stop?.at ?? null,
      stoppedBecause: stop?.reason ?? null,
      stopDetail: stop?.detail ?? null,
      toldToStopAt: stop?.toldToStopAt ?? null,
      stoppedForRunEnd: stop?.stoppedForRunEnd ?? false,
      replacedByAttempt: stop?.replacedByAttempt ?? null,
      planned: launch.planned,
    };
  });
}

/** The attempts grouped by the slice they ran, slices in generator order and attempts in the order they ran. */
export function attemptsBySlice(attempts: readonly Attempt[]) {
  const slices = new Map<number, Attempt[]>();
  for (const attempt of attempts) {
    slices.set(attempt.generator, [...(slices.get(attempt.generator) ?? []), attempt]);
  }
  return [...slices.entries()]
    .sort(([a], [b]) => a - b)
    .map(([generator, own]) => ({
      generator,
      attempts: [...own].sort((a, b) => a.attempt - b.attempt),
    }));
}
