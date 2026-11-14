import type { Judgement } from '../../types/criteria.ts';
import type { decide } from '../judging/decide.ts';
import type { scalingOf } from '../judging/scaling.ts';
import { compareText, roundTo } from '../numbers.ts';
import type {
  CrossCheck,
  Fewest,
  HoldFacts,
  Reason,
  RunFacts,
  SliceSummary,
  Summary,
} from '../types.ts';

type Decision = ReturnType<typeof decide>;

type ServiceScaling = ReturnType<typeof scalingOf>[number];

/** A table cell's text, safe to put between the bars: a bar in it would start a new cell, a line break would end the row, and a backslash would escape the bar that follows. */
export function cellText(cell: string | number | null) {
  if (cell === null) return 'n/a';
  return String(cell)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r?\n|\r/g, ' ');
}

const row = (cells: readonly (string | number | null)[]) =>
  `| ${cells.map(cellText).join(' | ')} |`;

const table = (header: readonly string[], rows: readonly string[]) => [
  row(header),
  row(header.map(() => '---')),
  ...rows,
];

/** A figure in the unit its criterion is measured in. */
export function figureText(unit: Judgement['unit'], value: number) {
  switch (unit) {
    case 'percent':
      return `${roundTo(value, 1)}%`;
    case 'share':
      return `${roundTo(value * 100, 2)}%`;
    case 'ms':
      return `${roundTo(value, 1)} ms`;
    case 'count':
      return roundTo(value, 1).toLocaleString('en-US');
  }
}

/** How each direction reads: the limit as a bound, and a figure on the wrong side of it. */
const DIRECTION_WORDS: Record<Judgement['direction'], { bound: string; miss: string }> = {
  'at-most': { bound: 'at most', miss: 'past its limit' },
  'at-least': { bound: 'at least', miss: 'short of its limit' },
};

/** A criterion's limit, in words. */
export const limitText = (judgement: Judgement) =>
  `${DIRECTION_WORDS[judgement.direction].bound} ${figureText(judgement.unit, judgement.limit)}`;

/** Where the criteria table would be, for a run judged on its records alone or not judged at all. */
const NO_JUDGEMENTS =
  'None judged. The verdict rests on the run being recorded whole, its records agreeing, and the run finishing its plan.';

/** What stands between a run and a pass, in words. */
export function reasonText(reason: Reason) {
  switch (reason.kind) {
    case 'criterion-missed':
      return `${reason.judgement.title} was ${figureText(reason.judgement.unit, reason.observed)}, ${DIRECTION_WORDS[reason.judgement.direction].miss} (${limitText(reason.judgement)})`;
    case 'criterion-not-judged':
      return `${reason.title} was not judged: the run recorded nothing to judge it by`;
    case 'criteria-unknown':
      return `the run could not be judged: ${reason.why}`;
    case 'guard-stopped':
      return `the guard stopped the run: ${reason.message}`;
    case 'sealed-incomplete':
      return `the archive sealed the run as incomplete (${reason.findings} finding${reason.findings === 1 ? '' : 's'})`;
    case 'file-unusable':
      return `${reason.path} ${reason.why}`;
    case 'records-disagree':
      return `the generators and ${reason.against} disagree on ${reason.what}`;
    case 'cross-check-not-made':
      return `the generators could not be checked against ${reason.against}: ${reason.why}`;
    case 'not-back-at-floor':
      return `${reason.service} still ran ${roundTo(reason.tasks, 1)} tasks at the end of the watch after the run, above its floor of ${reason.floor}`;
    case 'scaling-not-recorded':
      return `${reason.service} scales, and the run recorded none of its running tasks at the end of the watch${reason.atWatchEnd === null ? '' : ` (${reason.atWatchEnd})`} to judge it back at its floor by`;
    case 'never-ended':
      return 'the run never recorded its end';
    case 'ended-early':
      return `the run ended early (${reason.outcome})`;
  }
}

/** Whose limits judged the run. */
export const LIMITS_LINE = 'Judged by the limits recorded with the run when it began.';

/** The slices of the run, when any was down; null when none was. */
export function slicesWhenAnyDown(slices: readonly SliceSummary[]) {
  return slices.some((slice) => slice.down.length > 0) ? slices : null;
}

/** The verdict as the operator reads it. */
export function verdictText(input: {
  facts: Pick<RunFacts, 'run' | 'guardStop' | 'gaps' | 'slices' | 'summary' | 'hold'>;
  decision: Decision;
  judgements: readonly Judgement[];
  crossChecks: readonly CrossCheck[];
  scaling: ReturnType<typeof scalingOf>;
}) {
  const { run, guardStop, gaps } = input.facts;
  const lines: string[] = [
    `# Verdict: ${input.decision.verdict.toUpperCase()}`,
    '',
    `Run \`${run.runId}\`: step \`${run.step}\` on \`${run.target}\`, ${run.loadPath} path, ${run.startedAt} to ${run.endedAt ?? 'an end that was never recorded'}.`,
    `The archive sealed it as ${run.seal.status}. ${LIMITS_LINE}`,
    '',
  ];
  if (input.decision.reasons.length > 0) {
    lines.push('## What stands between the run and a pass', '');
    lines.push(...input.decision.reasons.map((reason) => `- ${reasonText(reason)}`), '');
  }
  lines.push('## Pass criteria', '');
  lines.push(
    ...(input.judgements.length === 0
      ? [NO_JUDGEMENTS]
      : table(
          ['Criterion', 'Limit', 'Observed', 'Result'],
          input.judgements.map((judgement) =>
            row([
              judgement.title,
              limitText(judgement),
              judgement.observed === null ? null : figureText(judgement.unit, judgement.observed),
              judgement.result,
            ]),
          ),
        )),
    '',
  );
  lines.push(...holdLines(input.facts.hold));
  lines.push(...scalingLines({ scaling: input.scaling, trailingEndsAt: run.trailingEndsAt }));
  lines.push(...pushStreamLines(input.facts.summary));
  if (guardStop !== null) {
    lines.push('## Stopped by the guard', '');
    lines.push(
      `The guard line \`${guardStop.line}\` was crossed at ${guardStop.from}: ${guardStop.message}. The run lost the window from ${guardStop.from} to ${guardStop.to}.`,
      '',
    );
  }
  lines.push(...refreshLines(input.facts.summary));
  lines.push('## Gaps', '');
  lines.push(
    ...(gaps.length === 0
      ? ['None.']
      : table(
          ['Source', 'From', 'To', 'What happened'],
          gaps.map((gap) => row([gap.source, gap.from, gap.to, gap.reason])),
        )),
    '',
  );
  lines.push(...sliceLines(slicesWhenAnyDown(input.facts.slices)));
  lines.push('## Cross-checks', '');
  lines.push(
    ...table(
      ['What', 'Generators', 'Against', 'Counted there', 'Result'],
      input.crossChecks.map((check) =>
        row([
          check.what,
          check.generators,
          check.against,
          check.other,
          `${check.result}: ${check.detail}`,
        ]),
      ),
    ),
    '',
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The slices of users, when one was down: each slice whole, whichever
 * generators held it. The criteria were judged without a slice's own
 * requests inside a window it was down. Nothing is said when no slice was
 * down.
 */
export function sliceLines(slices: readonly SliceSummary[] | null) {
  if (slices === null) return [];
  return [
    '## Slices',
    '',
    'A slice of users lost its generator, so it was down for a while. The pass criteria were judged without that slice’s own requests inside the windows it was down; every other request counts.',
    '',
    ...table(
      ['Generator', 'Users', 'Times down', 'Requests', 'Failed', 'Replies streamed', 'Down (s)'],
      slices.map((slice) =>
        row([
          slice.generator,
          `${slice.firstUser} to ${slice.lastUser}`,
          slice.down.length,
          slice.requests,
          slice.failedRequests,
          slice.chatsStreamed,
          slice.downSeconds,
        ]),
      ),
    ),
    '',
  ];
}

/** The hold alone: when the generators held fewest, and how fast chats were answered then. Nothing for a run with no hold. */
export function holdLines(hold: HoldFacts | null) {
  if (hold === null) return [];
  const fewest = (what: string, value: Fewest | null) =>
    row([what, value === null ? null : value.count.toLocaleString('en-US'), value?.at ?? null]);
  return [
    '## The hold',
    '',
    `Every slice held its users together from ${hold.from} to ${hold.to}.`,
    '',
    ...table(
      ['Figure', 'Value', 'At'],
      [
        fewest('Fewest push streams', hold.fewestPushStreams),
        fewest('Fewest chatters', hold.fewestChatters),
        row([
          'Chat first byte p95, in the hold alone',
          hold.chatFirstByteP95Ms === null
            ? null
            : `${figureText('ms', hold.chatFirstByteP95Ms)} over ${hold.chatsStreamed.toLocaleString('en-US')} chat${hold.chatsStreamed === 1 ? '' : 's'}`,
          null,
        ]),
      ],
    ),
    '',
  ];
}

/**
 * How each service that scales moved: its floor and ceiling, its most
 * running tasks and when, and when it was back at its floor. Nothing for a
 * step whose services run fixed counts.
 */
function scalingLines({
  scaling,
  trailingEndsAt,
}: {
  scaling: ReturnType<typeof scalingOf>;
  trailingEndsAt: string | null;
}) {
  if (scaling.length === 0) return [];
  const watch =
    trailingEndsAt === null
      ? 'The run kept no watch after its end.'
      : `The watch after the run ended at ${trailingEndsAt}.`;
  const backAt = (service: ServiceScaling) => {
    if (service.peak === null) return null;
    if (service.peak.tasks <= service.floor) return 'never left it';
    return service.backAtFloor ?? 'not back';
  };
  return [
    '## Scaling',
    '',
    `Running tasks of each service that scales, a minute at a time. ${watch}`,
    '',
    ...table(
      ['Service', 'Floor to ceiling', 'Peak tasks', 'At', 'Back at floor', 'Tasks at the end'],
      scaling.map((service) =>
        row([
          service.service,
          `${service.floor} to ${service.ceiling}`,
          service.peak?.tasks ?? null,
          service.peak?.minute ?? null,
          backAt(service),
          service.atEnd?.tasks ?? null,
        ]),
      ),
    ),
    '',
  ];
}

/** The push streams that ended before their users let them go. Nothing for a run whose generators opened none. */
export function pushStreamLines(summary: Pick<Summary, 'pushStreams'>) {
  const streams = summary.pushStreams;
  if (streams.opened === 0) return [];
  const count = (value: number) => value.toLocaleString('en-US');
  const most = streams.mostEndedInAMinute;
  return [
    '## Push streams that ended early',
    '',
    `A push stream cut off and opened again within ${streams.reopenedWithinSeconds} s is not counted as a failure.`,
    '',
    ...table(
      ['Push streams', 'Count'],
      [
        row(['Opened', count(streams.opened)]),
        row(['Ended before their users let them go', count(streams.endedEarly)]),
        row(['Of those, cut off rather than closed', count(streams.cut)]),
        row([
          `Of those, opened again within ${streams.reopenedWithinSeconds} s`,
          count(streams.reopened),
        ]),
        row([
          'Most that ended in one minute',
          most === null ? null : `${count(most.count)}, at ${most.minute}`,
        ]),
      ],
    ),
    '',
  ];
}

/** How many times users renewed their sessions, and which sessions the auth core ended instead. */
export function refreshLines(summary: Pick<Summary, 'requests'>) {
  const refreshes = summary.requests.byKind.refresh;
  if (refreshes === undefined) return ['## Session refreshes', '', 'None recorded.', ''];
  const failed = refreshes.byOutcome.failed ?? 0;
  const ended = summary.requests.failures.filter(
    (failure) => failure.kind === 'refresh' && failure.status === 401,
  );
  const endedCount = ended.reduce((total, failure) => total + failure.count, 0);
  const byReason = new Map<string, number>();
  for (const failure of ended) {
    const reason = failure.errorCode ?? 'no reason given';
    byReason.set(reason, (byReason.get(reason) ?? 0) + failure.count);
  }
  const reasons = [...byReason].sort(([a], [b]) => compareText(a, b));
  return [
    '## Session refreshes',
    '',
    `${refreshes.count} refreshes: ${refreshes.count - failed} renewed a session and ${failed} failed.`,
    endedCount === 0
      ? 'No session was ended.'
      : `Sessions the auth core ended: ${endedCount} (${reasons.map(([reason, count]) => `${reason}: ${count}`).join(', ')}).`,
    '',
  ];
}
