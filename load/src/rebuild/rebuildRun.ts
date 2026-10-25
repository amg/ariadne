import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnknownCriteria, judge } from '../criteria/index.ts';
import { LAYOUT } from '../records/index.ts';
import type { Judgement } from '../types/criteria.ts';
import {
  eventsLog,
  metricsTable,
  reasonText,
  slicesWhenAnyDown,
  verdictText,
} from './derived/index.ts';
import { runFactsOf } from './facts/index.ts';
import { crossCheckChats, crossCheckLoadBalancer, decide } from './judging/index.ts';
import { reportHtml } from './report/index.ts';
import { loadRun } from './runData/index.ts';
import { minuteTable } from './table/index.ts';
import type { RunFacts, Verdict } from './types.ts';

type Rebuilt = {
  verdict: Verdict;
  /** What stands between the run and a pass, in words; empty for a pass. */
  reasons: readonly string[];
  /** The verdict as written to the verdict file. */
  verdictText: string;
  /** The paths written, relative to the run folder. */
  written: string[];
};

/**
 * Turns a sealed run folder into numbers and a verdict, from its files
 * alone, judged by the limits the run recorded when it began. Its records
 * are read once, into a minute table and the run's facts; judging and the
 * report read those two alone. Everything is written under `derived/`,
 * replacing whatever was there. The same folder always gives the same bytes.
 */
export function rebuildRun(folder: string): Rebuilt {
  const data = loadRun(folder);
  const table = minuteTable(data);
  const facts = runFactsOf(data);
  const { judgements, criteriaUnknown } = judgedOrUnknown(facts);
  const crossChecks = [...crossCheckChats(facts), ...crossCheckLoadBalancer(table, facts)];
  const decision = decide({ facts, judgements, criteriaUnknown, crossChecks });
  const text = verdictText({ facts, decision, judgements, crossChecks });
  const reasons = decision.reasons.map(reasonText);
  const slices = slicesWhenAnyDown(facts.slices);
  const summary = {
    run: {
      id: facts.run.runId,
      step: facts.run.step,
      target: facts.run.target,
      loadPath: facts.run.loadPath,
      startedAt: facts.run.startedAt,
      endedAt: facts.run.endedAt,
      seal: facts.run.seal.status,
    },
    verdict: { result: decision.verdict, reasons, limits: facts.run.limits, judgements },
    hold: facts.hold,
    ...facts.summary,
    guardStop: facts.guardStop,
    gaps: facts.gaps,
    ...(slices === null ? {} : { slices }),
    crossChecks,
  };
  const files: [string, string][] = [
    [LAYOUT.summary, `${JSON.stringify(summary, null, 2)}\n`],
    [LAYOUT.verdict, text],
    [LAYOUT.metricsTable, metricsTable(table)],
    [LAYOUT.eventsLog, eventsLog(facts.timeline)],
    [LAYOUT.report, reportHtml({ facts, table, decision, judgements, crossChecks })],
  ];
  const derived = join(folder, LAYOUT.derivedDir);
  rmSync(derived, { recursive: true, force: true });
  mkdirSync(derived, { recursive: true });
  for (const [path, content] of files) writeFileSync(join(folder, path), content);
  return {
    verdict: decision.verdict,
    reasons,
    verdictText: text,
    written: files.map(([path]) => path),
  };
}

/**
 * Judges the run by the limits it recorded. A run that recorded none, or a
 * limit no criterion judges, is not judged at all, and says why, so that it
 * can never pass and its numbers are still written.
 */
function judgedOrUnknown(facts: Pick<RunFacts, 'run' | 'figures'>): {
  judgements: Judgement[];
  criteriaUnknown: string | null;
} {
  const { limits, step } = facts.run;
  if (limits === null) {
    return {
      judgements: [],
      criteriaUnknown: `no limits were defined for "${step}" when the run began`,
    };
  }
  try {
    return { judgements: judge(limits, facts.figures), criteriaUnknown: null };
  } catch (error) {
    if (!(error instanceof UnknownCriteria)) throw error;
    return { judgements: [], criteriaUnknown: error.message };
  }
}
