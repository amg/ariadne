import type { Judgement } from '../../types/criteria.ts';
import type { CrossCheck, Reason, RunFacts, Verdict } from '../types.ts';

type Decision = {
  verdict: Verdict;
  /** What stands between the run and a pass; empty for a pass. */
  reasons: readonly Reason[];
};

/** The guard line that stops a run because it cannot see the host, rather than because a criterion was crossed. */
const BLIND_GUARD_LINE = 'host-unreadable';

/**
 * Decides how a run came out, and lists everything that stands between it
 * and a pass. A run is a pass only when every criterion was judged and
 * held, the archive sealed it as complete, no file of it is missing or
 * changed, the records agree where they overlap, every cross-check the run
 * needs was made, and the run finished its plan without the guard stopping
 * it. A missed criterion, or a guard stop
 * on a criterion's line, fails the run; every other reason only leaves it
 * incomplete.
 */
export function decide(input: {
  facts: Pick<RunFacts, 'run' | 'trouble' | 'guardStop' | 'outcome'>;
  judgements: readonly Judgement[];
  /** Why the run could not be judged by its criteria at all; null when it was. */
  criteriaUnknown: string | null;
  crossChecks: readonly CrossCheck[];
}): Decision {
  const { facts, judgements, criteriaUnknown, crossChecks } = input;
  const { guardStop } = facts;
  const guardReason: Reason[] =
    guardStop === null ? [] : [{ kind: 'guard-stopped', message: guardStop.message }];
  const stoppedBlind = guardStop?.line === BLIND_GUARD_LINE;

  const failures: Reason[] = [
    ...judgements.flatMap((judgement): Reason[] =>
      judgement.result === 'fail' && judgement.observed !== null
        ? [{ kind: 'criterion-missed', judgement, observed: judgement.observed }]
        : [],
    ),
    ...(stoppedBlind ? [] : guardReason),
  ];
  const doubts: Reason[] = [
    ...(criteriaUnknown === null
      ? []
      : [{ kind: 'criteria-unknown', why: criteriaUnknown } as const]),
    ...judgements.flatMap((judgement): Reason[] =>
      judgement.result === 'not-judged'
        ? [{ kind: 'criterion-not-judged', title: judgement.title }]
        : [],
    ),
    ...(facts.run.seal.status === 'incomplete'
      ? [{ kind: 'sealed-incomplete', findings: facts.run.seal.reasons.length } as const]
      : []),
    ...facts.trouble.map(
      ({ path, reason }): Reason => ({ kind: 'file-unusable', path, why: reason }),
    ),
    ...crossChecks.flatMap((check): Reason[] =>
      check.result === 'mismatch'
        ? [{ kind: 'records-disagree', what: check.what, against: check.against }]
        : [],
    ),
    ...checksNotMade(crossChecks),
    ...(stoppedBlind ? guardReason : []),
    ...unfinished(facts.outcome),
  ];
  const reasons = [...failures, ...doubts];
  if (failures.length > 0) return { verdict: 'fail', reasons };
  return { verdict: doubts.length === 0 ? 'pass' : 'incomplete', reasons };
}

/** One reason for each source the run needed to cross-check against and could not, however many checks that kept from being made. */
function checksNotMade(crossChecks: readonly CrossCheck[]) {
  const reasons = new Map<string, Reason>();
  for (const { result, against, detail } of crossChecks) {
    if (result === 'not-made') {
      reasons.set(`${against}: ${detail}`, { kind: 'cross-check-not-made', against, why: detail });
    }
  }
  return [...reasons.values()];
}

/** Why the run did not finish its plan; nothing when it did. */
function unfinished(outcome: RunFacts['outcome']): Reason[] {
  if (outcome === null) return [{ kind: 'never-ended' }];
  return outcome === 'finished' ? [] : [{ kind: 'ended-early', outcome }];
}
