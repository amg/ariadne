import type { Direction, RunFigures, Unit } from '../types/criteria.ts';

/** A run's limits cannot be worked out, or name a line no criterion judges. */
export class UnknownCriteria extends Error {}

/** What a step's configuration says of its load. */
export type StepLoad = { users: number; chattingShare: number };

/** The size of a step's load, from its users and the share of them that chat. */
export function sizeOfLoad(load: StepLoad) {
  return { users: load.users, chatters: Math.round(load.users * load.chattingShare) };
}

/** One thing a run must stay on the right side of a limit on. */
export type Criterion = {
  id: string;
  title: string;
  /** The name of the line that holds this criterion's limit. */
  line: string;
  unit: Unit;
  /** A figure passes at or under its limit when the direction is `at-most`, and at or over it when `at-least`. */
  direction: Direction;
  /** The figure the criterion judges; null where the run recorded nothing to measure it by. */
  observe: (figures: RunFigures) => number | null;
};
