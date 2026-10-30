import { AWS_PROD_TARGET } from '../../records/index.ts';
import { instantOf } from '../moments.ts';
import {
  ANSWERED_BY_END,
  BALANCER_ANSWERS,
  PUSH_STREAMS_CUT,
  SLICES_DOWN,
  judgedMinutesOf,
  valuesOf,
} from '../table/index.ts';
import type { Cell, ChatCount, CrossCheck, MinuteTable, RunFacts } from '../types.ts';

/** How far two records of the same thing may differ before one of them cannot be trusted. */
export const TOLERANCE = { share: 0.01, atLeast: 2 };
const API = 'the API';
const LOAD_BALANCER_CHECKS = {
  perMinute: 'requests answered, by the minute',
  serverErrors: 'server errors (500s)',
  clientErrors: 'client errors (400s)',
} as const;
const LOAD_BALANCER = 'the load balancer';
const MISSING_REQUESTS = 'some generator’s request lines are missing';

/**
 * Sets what the generators say they saw against what the API says it
 * did: replies that streamed against exchanges that sent a first token,
 * and chats the gate paused against exchanges it paused. A mismatch
 * beyond the tolerance means one of the two records cannot be trusted.
 * Chats that arrived while a slice was down are left out of both sides,
 * and the detail says how many.
 */
export function crossCheckChats(facts: Pick<RunFacts, 'chats'>): CrossCheck[] {
  const { generators, api, leftOut } = facts.chats;
  const checks: [string, keyof ChatCount][] = [
    ['replies streamed', 'streamed'],
    ['chats paused by the gate', 'paused'],
  ];
  if (api === null) {
    return checks.map(([what]) => notMade(what, API, 'the API’s exchange lines are missing'));
  }
  if (generators === null) return checks.map(([what]) => notMade(what, API, MISSING_REQUESTS));
  const left = leftOutText([
    [leftOut.chats, 'chats from the generators'],
    [leftOut.exchanges, 'exchanges from the API'],
  ]);
  return checks.map(([what, count]) => compare(what, API, generators[count], api[count], left));
}

/** What the generators' lines, or the load balancer, counted in each minute. */
type Counted = { answered: number; serverErrors: number; clientErrors: number };

/**
 * Sets what the generators say they were answered against what the load
 * balancer says it answered: the answers minute by minute, and the answers
 * that were errors. The load balancer counts a request in the minute it
 * ends, so the generators' requests are counted by the minute they ended
 * in; a request that got no answer is not counted. A run that has no load
 * balancer, such as a home run, needs no such check, and neither does a run
 * through Cloudflare, whose edge turns some requests away before they
 * arrive. Every other run needs it, and cannot pass without it. A mismatch
 * beyond the tolerance means one of the two records cannot be trusted.
 * Only the minutes in which the generators carried the run's load are
 * compared, because thousands of push streams that close together at the
 * end of the hold can land either side of a minute's edge. Minutes in which
 * a slice was down are left out of both sides. The detail says how many
 * minutes each rule left out. Push streams that broke off are left out of
 * the generators' side, because the load balancer never counts them, and
 * the detail says how many.
 */
export function crossCheckLoadBalancer(
  table: MinuteTable,
  facts: Pick<RunFacts, 'run' | 'requestLinesWhole' | 'loadMinutes'>,
): CrossCheck[] {
  const exemption = reasonNotNeededOrNull(facts.run);
  if (exemption !== null) {
    return [notNeeded('every count set against the load balancer', LOAD_BALANCER, exemption)];
  }
  const balancer = countsOf(table, BALANCER_ANSWERS);
  const reason = reasonCannotCheckOrNull(balancer !== null, facts.requestLinesWhole);
  const generators = countsOf(table, {
    all: ANSWERED_BY_END.all,
    serverErrors: [ANSWERED_BY_END.serverErrors],
    clientErrors: [ANSWERED_BY_END.clientErrors],
  });
  if (reason !== null || balancer === null) {
    return Object.values(LOAD_BALANCER_CHECKS).map((name) =>
      notMade(name, LOAD_BALANCER, reason ?? ''),
    );
  }
  const minutes = answeredMinutesOf(table, generators);
  const loaded = new Set(facts.loadMinutes);
  const underLoad = minutes.filter((index) => loaded.has(table.minutes[index] ?? Number.NaN));
  const down = valuesOf(table, SLICES_DOWN);
  const kept = underLoad.filter((index) => (down[index] ?? 0) === 0);
  const left = [
    outsideLoadText(minutes.length - underLoad.length),
    leftOutText([[underLoad.length - kept.length, 'minutes']]),
  ]
    .filter((part) => part !== '')
    .join('; ');
  const cut = valuesOf(table, PUSH_STREAMS_CUT);
  const leftFromMinutes = [left, brokeOffText(sum(kept.map((index) => cut[index] ?? 0)))]
    .filter((part) => part !== '')
    .join('; ');
  const compared = kept.map((index) => ({
    minute: instantOf(table.minutes[index] ?? 0),
    generators: generators?.(index) ?? NOTHING,
    balancer: balancer(index),
  }));
  const total = (side: 'generators' | 'balancer', count: keyof Counted): number =>
    sum(compared.map((minute) => minute[side][count]));
  return [
    compareMinutes(LOAD_BALANCER_CHECKS.perMinute, compared, leftFromMinutes),
    compare(
      LOAD_BALANCER_CHECKS.serverErrors,
      LOAD_BALANCER,
      total('generators', 'serverErrors'),
      total('balancer', 'serverErrors'),
      left,
    ),
    compare(
      LOAD_BALANCER_CHECKS.clientErrors,
      LOAD_BALANCER,
      total('generators', 'clientErrors'),
      total('balancer', 'clientErrors'),
      left,
    ),
  ];
}

const NOTHING: Counted = { answered: 0, serverErrors: 0, clientErrors: 0 };

/**
 * What one side counted in each minute of the run, by the minute's place in
 * the table, from the columns named; a minute a column has no figure for
 * counts nothing. Null when the table has none of the columns that count
 * every answer.
 */
function countsOf(
  table: MinuteTable,
  columns: {
    all: string;
    serverErrors: readonly string[];
    clientErrors: readonly string[];
  },
): ((index: number) => Counted) | null {
  const all = valuesOf(table, columns.all);
  if (all.every((value) => value === null)) return null;
  const added = (names: readonly string[]) => {
    const series = names.map((name) => valuesOf(table, name));
    return (index: number): number => sum(series.map((values) => cellOrZero(values[index])));
  };
  const serverErrors = added(columns.serverErrors);
  const clientErrors = added(columns.clientErrors);
  return (index) => ({
    answered: cellOrZero(all[index]),
    serverErrors: serverErrors(index),
    clientErrors: clientErrors(index),
  });
}

const cellOrZero = (cell: Cell | undefined) => cell ?? 0;

/**
 * The places in the table of every minute of the run from the first to the
 * last in which the generators were answered, so that a minute they were
 * silent in is compared too.
 */
function answeredMinutesOf(table: MinuteTable, generators: ((index: number) => Counted) | null) {
  const judged = judgedMinutesOf(table).map((_, index) => index);
  const answered = judged.filter((index) => (generators?.(index).answered ?? 0) > 0);
  const first = answered[0];
  const last = answered.at(-1);
  if (first === undefined || last === undefined) return [];
  return judged.filter((index) => index >= first && index <= last);
}

const sum = (counts: readonly number[]) => counts.reduce((total, count) => total + count, 0);

/** Every minute must agree with the load balancer; the mismatch names the worst. */
function compareMinutes(
  what: string,
  minutes: readonly { minute: string; generators: Counted; balancer: Counted }[],
  leftOut: string,
): CrossCheck {
  const apart = minutes
    .map(({ minute, generators, balancer }) => ({
      minute,
      generators: generators.answered,
      balancer: balancer.answered,
    }))
    .map((counts) => ({
      ...counts,
      difference: Math.abs(counts.generators - counts.balancer),
      allowed: allowedDifference(Math.max(counts.generators, counts.balancer)),
    }))
    .filter(({ difference, allowed }) => difference > allowed);
  const worst = apart.reduce<(typeof apart)[number] | null>(
    (most, minute) => (most === null || minute.difference > most.difference ? minute : most),
    null,
  );
  const base = {
    what,
    against: LOAD_BALANCER,
    generators: sum(minutes.map(({ generators }) => generators.answered)),
    other: sum(minutes.map(({ balancer }) => balancer.answered)),
  };
  if (worst === null) {
    return {
      ...base,
      result: 'agree',
      detail: withLeftOut(`all ${minutes.length} minutes within tolerance`, leftOut),
    };
  }
  return {
    ...base,
    result: 'mismatch',
    detail: withLeftOut(
      `${apart.length} of ${minutes.length} minutes differ by more than allowed; the worst, ${worst.minute}, has ${worst.generators} from the generators and ${worst.balancer} at the load balancer`,
      leftOut,
    ),
  };
}

function reasonCannotCheckOrNull(hasBalancer: boolean, requestLinesWhole: boolean): string | null {
  if (!hasBalancer) return 'the load balancer’s metrics are missing';
  return requestLinesWhole ? null : MISSING_REQUESTS;
}

function reasonNotNeededOrNull(run: Pick<RunFacts['run'], 'target' | 'loadPath'>): string | null {
  if (run.target !== AWS_PROD_TARGET) {
    return 'this run has no load balancer, so there is nothing to set the counts against';
  }
  if (run.loadPath === 'cloudflare') {
    return 'through Cloudflare the edge answers some requests itself, so the counts cannot be set against the load balancer’s';
  }
  return null;
}

function notMade(what: string, against: string, detail: string): CrossCheck {
  return { what, against, generators: null, other: null, result: 'not-made', detail };
}

function notNeeded(what: string, against: string, detail: string): CrossCheck {
  return { what, against, generators: null, other: null, result: 'not-needed', detail };
}

/** What was left out because a slice was down then; empty when nothing was. */
function leftOutText(counts: readonly [number, string][]) {
  const parts = counts.filter(([count]) => count > 0).map(([count, what]) => `${count} ${what}`);
  return parts.length === 0 ? '' : `left out as inside a gap: ${parts.join(' and ')}`;
}

/** The minutes left out as outside the load the generators carried; empty when none were. */
function outsideLoadText(count: number) {
  return count === 0
    ? ''
    : `left out as a generator starting or its users stopping: ${count} minute${count === 1 ? '' : 's'}`;
}

/** The push streams that broke off in the minutes compared, left out of the generators' count; empty when none did. */
function brokeOffText(count: number) {
  return count === 0
    ? ''
    : `left out as never completed at the load balancer: ${count} push stream${count === 1 ? '' : 's'} that broke off`;
}

const withLeftOut = (detail: string, leftOut: string) =>
  leftOut === '' ? detail : `${detail}; ${leftOut}`;

function allowedDifference(count: number) {
  return Math.max(TOLERANCE.atLeast, Math.ceil(count * TOLERANCE.share));
}

function compare(
  what: string,
  against: string,
  generators: number,
  other: number,
  leftOut: string,
): CrossCheck {
  const allowed = allowedDifference(generators);
  const difference = Math.abs(generators - other);
  const agree = difference <= allowed;
  return {
    what,
    against,
    generators,
    other,
    result: agree ? 'agree' : 'mismatch',
    detail: withLeftOut(
      agree ? `within ${allowed}` : `differ by ${difference}, more than the ${allowed} allowed`,
      leftOut,
    ),
  };
}
