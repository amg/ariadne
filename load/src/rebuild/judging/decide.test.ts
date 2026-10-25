import { describe, expect, it } from 'vitest';
import type { Judgement } from '../../types/criteria.ts';
import { runFactsOf } from '../facts/index.ts';
import { ENDED, at, manifestWith, runDataWith } from '../runData/testing.ts';
import { minuteTable } from '../table/index.ts';
import type { CrossCheck } from '../types.ts';
import { crossCheckLoadBalancer } from './crossChecks.ts';
import { decide } from './decide.ts';

const held: Judgement = {
  id: 'a',
  title: 'A',
  unit: 'percent',
  direction: 'at-most',
  limit: 70,
  observed: 40,
  result: 'pass',
};
const missed: Judgement = { ...held, title: 'Host CPU', observed: 81, result: 'fail' };
const unjudged: Judgement = {
  ...held,
  title: 'Memory in use',
  observed: null,
  result: 'not-judged',
};
const agree: CrossCheck = {
  what: 'replies streamed',
  against: 'the API',
  generators: 5,
  other: 5,
  result: 'agree',
  detail: '',
};
type GuardStop = NonNullable<ReturnType<typeof runFactsOf>['guardStop']>;
const guard: GuardStop = {
  line: 'host-cpu',
  message: 'host CPU was 81%',
  observed: 81,
  limit: 70,
  from: at(100),
  to: ENDED,
};
const blindGuard: GuardStop = {
  ...guard,
  line: 'host-unreadable',
  message: 'the host could not be read',
};

const decideWith = (
  input: {
    data?: ReturnType<typeof runDataWith>;
    guardStop?: GuardStop | null;
  } & Partial<
    Pick<Parameters<typeof decide>[0], 'judgements' | 'criteriaUnknown' | 'crossChecks'>
  > = {},
) => {
  const { data = runDataWith(), guardStop = null, ...rest } = input;
  return decide({
    facts: { ...runFactsOf(data), guardStop },
    judgements: [held],
    criteriaUnknown: null,
    crossChecks: [agree],
    ...rest,
  });
};

const loadBalancerChecks = (data: ReturnType<typeof runDataWith>) =>
  crossCheckLoadBalancer(minuteTable(data), runFactsOf(data));

describe('decide', () => {
  it('passes a finished, sealed run that held every criterion', () => {
    expect(decideWith()).toEqual({ verdict: 'pass', reasons: [] });
  });

  it('fails a run that missed a criterion, and keeps the judgement and the figure', () => {
    expect(decideWith({ judgements: [held, missed] })).toEqual({
      verdict: 'fail',
      reasons: [{ kind: 'criterion-missed', judgement: missed, observed: 81 }],
    });
  });

  describe('a guard stop', () => {
    it('on a criterion’s line fails the run, once', () => {
      expect(decideWith({ guardStop: guard })).toEqual({
        verdict: 'fail',
        reasons: [{ kind: 'guard-stopped', message: 'host CPU was 81%' }],
      });
    });

    it('because the guard was blind only leaves the run incomplete, once', () => {
      expect(decideWith({ guardStop: blindGuard })).toEqual({
        verdict: 'incomplete',
        reasons: [{ kind: 'guard-stopped', message: 'the host could not be read' }],
      });
    });
  });

  it('cannot pass a criterion that was not judged', () => {
    expect(decideWith({ judgements: [held, unjudged] })).toEqual({
      verdict: 'incomplete',
      reasons: [{ kind: 'criterion-not-judged', title: 'Memory in use' }],
    });
  });

  it('passes a run whose criteria set no limits, on its records alone', () => {
    expect(decideWith({ judgements: [] })).toEqual({ verdict: 'pass', reasons: [] });
  });

  it('cannot pass a run whose limits no criterion judges', () => {
    const why = 'no limits were defined for "step50" when the run began';

    expect(decideWith({ judgements: [], criteriaUnknown: why })).toEqual({
      verdict: 'incomplete',
      reasons: [{ kind: 'criteria-unknown', why }],
    });
  });

  it('can never pass a run sealed as incomplete', () => {
    const manifest = manifestWith({
      seal: {
        status: 'incomplete',
        sealedAt: at(181),
        reasons: [{ check: 'checksums', detail: 'x is gone', path: 'x' }],
      },
    });

    expect(decideWith({ data: runDataWith({ manifest }) })).toEqual({
      verdict: 'incomplete',
      reasons: [{ kind: 'sealed-incomplete', findings: 1 }],
    });
  });

  it('cannot pass a run with a file that changed after sealing', () => {
    const data = runDataWith({
      trouble: [{ path: 'requests/a.jsonl', reason: 'changed since the run was sealed' }],
    });

    expect(decideWith({ data }).reasons).toEqual([
      { kind: 'file-unusable', path: 'requests/a.jsonl', why: 'changed since the run was sealed' },
    ]);
  });

  it('cannot pass when the generators and the API disagree', () => {
    const disagree: CrossCheck = { ...agree, other: 50, result: 'mismatch' };

    expect(decideWith({ crossChecks: [disagree] }).reasons).toEqual([
      { kind: 'records-disagree', what: 'replies streamed', against: 'the API' },
    ]);
  });

  describe('a cross-check that was not made', () => {
    const notMade: CrossCheck = {
      ...agree,
      generators: null,
      other: null,
      result: 'not-made',
      detail: 'the API’s exchange lines are missing',
    };

    it('cannot pass, and is named once for each source however many checks it kept from being made', () => {
      const decision = decideWith({ crossChecks: [notMade, { ...notMade, what: 'paused' }] });

      expect(decision.verdict).toBe('incomplete');
      expect(decision.reasons).toEqual([
        {
          kind: 'cross-check-not-made',
          against: 'the API',
          why: 'the API’s exchange lines are missing',
        },
      ]);
    });

    it('does not stand in the way of a check the run never needed', () => {
      const exempt: CrossCheck = { ...notMade, result: 'not-needed' };

      expect(decideWith({ crossChecks: [exempt] })).toEqual({ verdict: 'pass', reasons: [] });
    });

    it('stops a direct-path aws-prod run without the load balancer’s metrics, and not a home run', () => {
      const direct = runDataWith({
        manifest: manifestWith({ target: 'aws-prod', loadPath: 'direct' }),
      });
      const home = runDataWith();

      const verdictOf = (data: ReturnType<typeof runDataWith>) =>
        decideWith({ data, crossChecks: [agree, ...loadBalancerChecks(data)] }).verdict;

      expect(verdictOf(direct)).toBe('incomplete');
      expect(verdictOf(home)).toBe('pass');
    });

    it('does not stop a run through Cloudflare, whose counts are not set against the load balancer', () => {
      const data = runDataWith({
        manifest: manifestWith({ target: 'aws-prod', loadPath: 'cloudflare' }),
      });

      expect(decideWith({ data, crossChecks: loadBalancerChecks(data) }).verdict).toBe('pass');
    });
  });

  it('cannot pass a run that ended early, or never recorded its end', () => {
    const early = runDataWith({
      events: [{ kind: 'run-ended', at: ENDED, outcome: 'interrupted' }],
    });
    const unended = runDataWith({ events: [] });

    expect(decideWith({ data: early }).reasons).toEqual([
      { kind: 'ended-early', outcome: 'interrupted' },
    ]);
    expect(decideWith({ data: unended }).reasons).toEqual([{ kind: 'never-ended' }]);
  });

  it('puts a missed criterion above every doubt, and still lists the doubts', () => {
    const decision = decideWith({
      judgements: [missed, unjudged],
      crossChecks: [{ ...agree, result: 'mismatch' }],
    });

    expect(decision.verdict).toBe('fail');
    expect(decision.reasons.map(({ kind }) => kind)).toEqual([
      'criterion-missed',
      'criterion-not-judged',
      'records-disagree',
    ]);
  });
});
