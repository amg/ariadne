import { parseArgs } from 'node:util';
import { GUARD_LINES } from '../criteria/index.ts';
import type { GuardLines } from '../types/criteria.ts';
import { LOAD_ACCOUNTS } from './loadAccounts.ts';
import { TargetRefused, parseTarget } from './stack/index.ts';
import { tightened } from './watch/index.ts';

/** Which inference the run's backend talks to. The mock costs nothing; real spends money. */
export type Inference = 'mock' | 'real';

/**
 * A home run: a few users arriving over the ramp, then holding, all of them
 * chatting. It proves the harness works and that a run can be driven end to
 * end; the home machine is not a stress target.
 */
type RunOptions = {
  inference: Inference;
  users: number;
  /** How many generators share the users, a slice each. */
  generators: number;
  rampSeconds: number;
  holdSeconds: number;
  thinkSeconds: number;
  guard: GuardLines;
};

const DEFAULTS = {
  users: 20,
  mostUsers: 50,
  /** Several, so that losing one leaves the others to carry on. */
  generators: 4,
  mostGenerators: 10,
  rampSeconds: 5,
  /** Longer than the five minutes dev's access token lasts, so every user refreshes at least once. */
  holdSeconds: 6 * 60,
  thinkSeconds: 5,
} as const;

const MOST_HOLD_MINUTES = 20;

/**
 * The options of a home run. A run that names no inference uses the mock,
 * so a forgotten option never spends money. The target is checked first:
 * only dev can be run from here. Guard lines may be tightened and never
 * loosened.
 */
export function parseRunOptions(argv: readonly string[]): RunOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      target: { type: 'string' },
      inference: { type: 'string' },
      users: { type: 'string' },
      generators: { type: 'string' },
      'hold-minutes': { type: 'string' },
      'max-host-cpu': { type: 'string' },
      'max-memory-percent': { type: 'string' },
      'max-first-byte-ms': { type: 'string' },
      'max-error-percent': { type: 'string' },
    },
    strict: true,
  });

  const target = parseTarget(values.target ?? 'dev');
  if (target.kind !== 'dev') {
    throw new TargetRefused(
      `"${target.step}" is an aws-prod step: it runs through \`aws-prod load\`, not from here.`,
    );
  }
  const users =
    values.users === undefined
      ? DEFAULTS.users
      : wholeNumberOf(values.users, DEFAULTS.mostUsers, '--users');
  return {
    inference: inferenceOf(values.inference),
    users,
    generators: generatorsOf(values.generators, users),
    rampSeconds: DEFAULTS.rampSeconds,
    holdSeconds:
      values['hold-minutes'] === undefined
        ? DEFAULTS.holdSeconds
        : holdSecondsOf(values['hold-minutes'], '--hold-minutes'),
    thinkSeconds: DEFAULTS.thinkSeconds,
    guard: tightened(GUARD_LINES, guardOverridesOf(values)),
  };
}

/** How many load accounts to create. */
export function parseAccountsCount(argv: readonly string[]) {
  const { values } = parseArgs({
    args: [...argv],
    options: { users: { type: 'string' } },
    strict: true,
  });
  if (values.users === undefined) return LOAD_ACCOUNTS.defaultCount;
  return wholeNumberOf(values.users, LOAD_ACCOUNTS.largestCount, '--users');
}

function inferenceOf(raw: string | undefined) {
  if (raw === undefined || raw === 'mock') return 'mock';
  if (raw === 'real') return 'real';
  throw new Error(`--inference must be "mock" or "real", got "${raw}"`);
}

/** How many generators share the users; never more than the users, since each generator needs one. */
function generatorsOf(raw: string | undefined, users: number) {
  if (raw === undefined) return Math.min(DEFAULTS.generators, users);
  const count = wholeNumberOf(raw, DEFAULTS.mostGenerators, '--generators');
  if (count > users) {
    throw new Error(
      `--generators ${count} is more than the ${users} users: each generator needs a user`,
    );
  }
  return count;
}

/** A hold of whole minutes, so a run can outlast several token lifetimes; never longer than 20 minutes. */
function holdSecondsOf(raw: string, flag: string) {
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MOST_HOLD_MINUTES) {
    throw new Error(`${flag} must be a whole number from 1 to ${MOST_HOLD_MINUTES}, got "${raw}"`);
  }
  return minutes * 60;
}

function wholeNumberOf(raw: string, most: number, flag: string) {
  const value = Number(raw);
  if (raw === '' || !Number.isInteger(value) || value < 1 || value > most) {
    throw new Error(`${flag} must be a whole number from 1 to ${most}, got "${raw}"`);
  }
  return value;
}

function guardOverridesOf(values: {
  'max-host-cpu'?: string;
  'max-memory-percent'?: string;
  'max-first-byte-ms'?: string;
  'max-error-percent'?: string;
}) {
  const overrides: Partial<GuardLines> = {};
  const cpu = numberOf(values['max-host-cpu'], '--max-host-cpu');
  if (cpu !== undefined) overrides.maxHostCpuPercent = cpu;
  const memory = numberOf(values['max-memory-percent'], '--max-memory-percent');
  if (memory !== undefined) overrides.maxMemoryUsedPercent = memory;
  const firstByte = numberOf(values['max-first-byte-ms'], '--max-first-byte-ms');
  if (firstByte !== undefined) overrides.maxFirstByteP95Ms = firstByte;
  const errors = numberOf(values['max-error-percent'], '--max-error-percent');
  if (errors !== undefined) overrides.maxErrorShare = errors / 100;
  return overrides;
}

/** A number of zero or more from an option; nothing when the option was not given. */
function numberOf(raw: string | undefined, flag: string) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${flag} must be a number of zero or more, got "${raw}"`);
  }
  return value;
}
