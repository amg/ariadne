import { describe, expect, it } from 'vitest';
import type { Limits, RunFigures } from '../types/criteria.ts';
import { judge } from './criteria.ts';
import { UnknownCriteria } from './criterion.ts';
import { GUARD_LINES } from './guardLines.ts';
import { HOME_LINES } from './home.ts';
import { limitsFor } from './limits.ts';
import { SIZED_FIXED_LINES, sizedLines } from './sized.ts';

const calm: RunFigures = {
  hostCpuPercentMax: 40,
  memoryUsedPercentMax: 55.5,
  chatFirstByteP95Ms: 120,
  errorShare: 0,
  pushStreamsLeastInHold: 49_500,
  chattersLeastInHold: 9_900,
  signInFailureShare: 0.001,
  gateWaitAtLimitShare: 0.001,
  generatorCpuPercentMax: 55,
};

/** The configuration a step records, from which its size is read. */
const configOf = (users: number, chattingShare: number) => ({ load: { users, chattingShare } });

const resultsOf = (figures: RunFigures, limits: Limits = HOME_LINES) =>
  Object.fromEntries(judge(limits, figures).map(({ id, result }) => [id, result]));

describe('judging a home run', () => {
  it('passes every criterion a run stays inside', () => {
    expect(resultsOf(calm)).toEqual({
      'host-cpu': 'pass',
      memory: 'pass',
      'first-byte-p95': 'pass',
      errors: 'pass',
    });
  });

  it('fails host CPU only above its line', () => {
    expect(resultsOf({ ...calm, hostCpuPercentMax: 70 })['host-cpu']).toBe('pass');
    expect(resultsOf({ ...calm, hostCpuPercentMax: 70.1 })['host-cpu']).toBe('fail');
  });

  it('fails memory only above its line', () => {
    expect(resultsOf({ ...calm, memoryUsedPercentMax: 80 }).memory).toBe('pass');
    expect(resultsOf({ ...calm, memoryUsedPercentMax: 80.5 }).memory).toBe('fail');
  });

  it('fails the first byte p95 only above its line', () => {
    expect(resultsOf({ ...calm, chatFirstByteP95Ms: 2_500 })['first-byte-p95']).toBe('pass');
    expect(resultsOf({ ...calm, chatFirstByteP95Ms: 2_501 })['first-byte-p95']).toBe('fail');
  });

  it('fails the error share only above its line', () => {
    expect(resultsOf({ ...calm, errorShare: 0.01 }).errors).toBe('pass');
    expect(resultsOf({ ...calm, errorShare: 0.0101 }).errors).toBe('fail');
  });

  it('does not judge a criterion the run has nothing to measure', () => {
    const results = resultsOf({ ...calm, hostCpuPercentMax: null, errorShare: null });
    expect(results['host-cpu']).toBe('not-judged');
    expect(results.errors).toBe('not-judged');
    expect(results.memory).toBe('pass');
  });

  it('judges by the limits the run recorded', () => {
    expect(resultsOf(calm, { ...HOME_LINES, maxHostCpuPercent: 30 })['host-cpu']).toBe('fail');
  });

  it('gives the limit and the figure as numbers, with the unit they are in', () => {
    const [cpu, , firstByte, errors] = judge(HOME_LINES, {
      ...calm,
      chatFirstByteP95Ms: 83.46,
      errorShare: 0.00512,
    });
    expect(cpu).toMatchObject({ unit: 'percent', limit: 70, observed: 40 });
    expect(firstByte).toMatchObject({ unit: 'ms', limit: 2_500, observed: 83.46 });
    expect(errors).toMatchObject({ unit: 'share', limit: 0.01, observed: 0.00512 });
  });

  it('judges only the lines the run recorded', () => {
    expect(resultsOf(calm, { maxHostCpuPercent: 70 })).toEqual({ 'host-cpu': 'pass' });
  });

  it('refuses a line that no criterion judges', () => {
    expect(() => judge({ maxSomethingElse: 1 }, calm)).toThrow(UnknownCriteria);
  });
});

describe('the limits a new run records', () => {
  it('are the guard’s lines for a home run, so that the guard and the verdict agree', () => {
    expect(limitsFor('home-smoke', {})).toBe(GUARD_LINES);
  });

  it('are none for smoke, whose verdict rests on the run’s records alone', () => {
    const smoke = limitsFor('smoke', {});

    expect(smoke).toEqual({});
    expect(judge(smoke ?? {}, calm)).toEqual([]);
  });

  it('are null for a step that has none yet', () => {
    expect(limitsFor('step100', configOf(100_000, 0.2))).toBeNull();
  });
});

describe('the sized steps’ limits', () => {
  const step50 = limitsFor('step50', configOf(50_000, 0.2)) ?? {};
  const resultsFor = (figures: RunFigures) => resultsOf(figures, step50);

  it('are one family, written once for step10 and step50 and scaled by the step’s users and chatters', () => {
    expect(step50).toEqual({
      minPushStreams: 49_000,
      minChatters: 9_800,
      maxFirstByteP95Ms: 2_500,
      maxGateWaitAtLimitShare: 0.005,
      maxSignInFailureShare: 0.005,
      maxGeneratorCpuPercent: 70,
    });
    const step10 = limitsFor('step10', configOf(10_000, 0.2));
    expect(step10).toMatchObject({ minPushStreams: 9_800, minChatters: 1_960 });
    expect(step10).toMatchObject(SIZED_FIXED_LINES);
  });

  it('round a scaled line down, so that a whole number of users is asked', () => {
    expect(sizedLines({ users: 12_345, chatters: 2_469 })).toMatchObject({
      minPushStreams: 12_098,
      minChatters: 2_419,
    });
  });

  it('cannot be worked out for a step whose configuration does not give its size', () => {
    expect(() => limitsFor('step50', {})).toThrow(/cannot be worked out/);
    expect(() => limitsFor('step50', { load: { users: 50_000 } })).toThrow(UnknownCriteria);
  });

  it('pass a run that stays on the right side of every line', () => {
    expect(resultsFor(calm)).toEqual({
      'push-streams': 'pass',
      chatters: 'pass',
      'first-byte-p95': 'pass',
      'gate-waits-at-limit': 'pass',
      'sign-in-failures': 'pass',
      'generator-cpu': 'pass',
    });
  });

  it.each([
    ['push-streams', 'pushStreamsLeastInHold', 49_000],
    ['chatters', 'chattersLeastInHold', 9_800],
  ] as const)('fail %s only below its line, since more is better', (id, figure, line) => {
    expect(resultsFor({ ...calm, [figure]: line })[id]).toBe('pass');
    expect(resultsFor({ ...calm, [figure]: line - 1 })[id]).toBe('fail');
    expect(resultsFor({ ...calm, [figure]: line + 1 })[id]).toBe('pass');
  });

  it.each([
    ['first-byte-p95', 'chatFirstByteP95Ms', 2_500],
    ['gate-waits-at-limit', 'gateWaitAtLimitShare', 0.005],
    ['sign-in-failures', 'signInFailureShare', 0.005],
    ['generator-cpu', 'generatorCpuPercentMax', 70],
  ] as const)('fail %s only above its line, since less is better', (id, figure, line) => {
    expect(resultsFor({ ...calm, [figure]: line })[id]).toBe('pass');
    expect(resultsFor({ ...calm, [figure]: line * 1.01 })[id]).toBe('fail');
    expect(resultsFor({ ...calm, [figure]: line * 0.99 })[id]).toBe('pass');
  });

  it('do not judge a line the run has no reading for', () => {
    const results = resultsFor({
      ...calm,
      pushStreamsLeastInHold: null,
      generatorCpuPercentMax: null,
    });
    expect(results['push-streams']).toBe('not-judged');
    expect(results['generator-cpu']).toBe('not-judged');
    expect(results.chatters).toBe('pass');
  });

  it('say which way each line is held, with the limit and the figure as numbers', () => {
    const judgements = judge(step50, { ...calm, pushStreamsLeastInHold: 48_000 });
    expect(judgements.find(({ id }) => id === 'push-streams')).toMatchObject({
      direction: 'at-least',
      unit: 'count',
      limit: 49_000,
      observed: 48_000,
      result: 'fail',
    });
    expect(judgements.find(({ id }) => id === 'generator-cpu')).toMatchObject({
      direction: 'at-most',
      unit: 'percent',
      limit: 70,
    });
  });

  it('turn the pass lines of the catalogue into the shares a run is judged by', () => {
    expect(SIZED_FIXED_LINES).toEqual({
      maxFirstByteP95Ms: 2_500,
      maxGateWaitAtLimitShare: 0.005,
      maxSignInFailureShare: 0.005,
      maxGeneratorCpuPercent: 70,
    });
  });
});
