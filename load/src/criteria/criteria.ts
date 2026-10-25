import type { Direction, Judgement, Limits, RunFigures } from '../types/criteria.ts';
import { type Criterion, UnknownCriteria } from './criterion.ts';

/**
 * Every criterion a run can be judged by, one for each line a run's
 * limits can hold, in the order a verdict lists them.
 */
const CRITERIA: readonly Criterion[] = [
  {
    id: 'push-streams',
    title: 'Push streams open through the hold',
    line: 'minPushStreams',
    unit: 'count',
    direction: 'at-least',
    observe: (figures) => figures.pushStreamsLeastInHold,
  },
  {
    id: 'chatters',
    title: 'Chatters active through the hold',
    line: 'minChatters',
    unit: 'count',
    direction: 'at-least',
    observe: (figures) => figures.chattersLeastInHold,
  },
  {
    id: 'host-cpu',
    title: 'Host CPU',
    line: 'maxHostCpuPercent',
    unit: 'percent',
    direction: 'at-most',
    observe: (figures) => figures.hostCpuPercentMax,
  },
  {
    id: 'memory',
    title: 'Memory in use',
    line: 'maxMemoryUsedPercent',
    unit: 'percent',
    direction: 'at-most',
    observe: (figures) => figures.memoryUsedPercentMax,
  },
  {
    id: 'first-byte-p95',
    title: 'Chat first byte p95',
    line: 'maxFirstByteP95Ms',
    unit: 'ms',
    direction: 'at-most',
    observe: (figures) => figures.chatFirstByteP95Ms,
  },
  {
    id: 'errors',
    title: 'Requests that failed',
    line: 'maxErrorShare',
    unit: 'share',
    direction: 'at-most',
    observe: (figures) => figures.errorShare,
  },
  {
    id: 'gate-waits-at-limit',
    title: 'Gate waits that hit the limit',
    line: 'maxGateWaitAtLimitShare',
    unit: 'share',
    direction: 'at-most',
    observe: (figures) => figures.gateWaitAtLimitShare,
  },
  {
    id: 'sign-in-failures',
    title: 'Sign-ins that failed',
    line: 'maxSignInFailureShare',
    unit: 'share',
    direction: 'at-most',
    observe: (figures) => figures.signInFailureShare,
  },
  {
    id: 'generator-cpu',
    title: 'Busiest generator CPU',
    line: 'maxGeneratorCpuPercent',
    unit: 'percent',
    direction: 'at-most',
    observe: (figures) => figures.generatorCpuPercentMax,
  },
];

function resultOf(direction: Direction, observed: number | null, limit: number) {
  if (observed === null) return 'not-judged';
  const held = direction === 'at-most' ? observed <= limit : observed >= limit;
  return held ? 'pass' : 'fail';
}

/**
 * Judges what a run showed by the limits it recorded: one judgement for
 * each line the limits hold, and none for a line they leave out. A line
 * that no criterion judges is refused rather than guessed at.
 */
export function judge(limits: Limits, figures: RunFigures) {
  const unknown = Object.keys(limits).filter(
    (line) => !CRITERIA.some((criterion) => criterion.line === line),
  );
  if (unknown.length > 0) {
    throw new UnknownCriteria(`No criterion judges the line ${unknown.join(', ')}`);
  }
  return CRITERIA.flatMap((criterion): Judgement[] => {
    const limit = limits[criterion.line];
    if (limit === undefined) return [];
    const observed = criterion.observe(figures);
    return [
      {
        id: criterion.id,
        title: criterion.title,
        unit: criterion.unit,
        direction: criterion.direction,
        limit,
        observed,
        result: resultOf(criterion.direction, observed, limit),
      },
    ];
  });
}
