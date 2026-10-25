import { INSIGHT_DIMENSIONS, type Insight } from '../../records/index.ts';
import { minuteStartOf } from '../moments.ts';
import { compareText, maxOf, roundTo } from '../numbers.ts';
import { runMinutesOf } from '../runData/index.ts';
import type { Load, QueryLoad, RunData } from '../types.ts';

/** One wait or query, what names it, and the sessions it held in each minute it was listed. */
type Group = { key: string; dimensions: Readonly<Record<string, string>>; sessions: number[] };

function groupedBy(insights: readonly Insight[], keyOf: (insight: Insight) => string) {
  const groups = new Map<string, Group>();
  for (const insight of insights) {
    const key = keyOf(insight);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        key,
        dimensions: insight.dimensions,
        sessions: [insight.averageActiveSessions],
      });
    } else {
      group.sessions.push(insight.averageActiveSessions);
    }
  }
  return [...groups.values()];
}

/** Puts the group that held the most sessions on average first, the one that peaked highest breaking a tie. */
function busiestFirst(a: Load & { key: string }, b: Load & { key: string }) {
  return (
    b.meanSessions - a.meanSessions || b.peakSessions - a.peakSessions || compareText(a.key, b.key)
  );
}

/**
 * What Performance Insights saw of the database over the run's minutes:
 * each of its busiest waits and queries, with the sessions it held, and
 * the busiest statements behind each wait when the run kept them. A
 * wait's average is over every minute Performance Insights measured, so a
 * minute it was not listed in counts as none. Null for a run that kept no
 * Performance Insights.
 */
export function insightsSummary(data: RunData) {
  if (data.insights === null) return null;
  const minutes = runMinutesOf(data);
  const runFrom = minutes[0] ?? 0;
  const runTo = minutes.at(-1) ?? runFrom;
  const inRun = data.insights.filter((insight) => {
    const minute = minuteStartOf(Date.parse(insight.at));
    return minute >= runFrom && minute <= runTo;
  });
  const measured = new Set(inRun.map((insight) => minuteStartOf(Date.parse(insight.at)))).size;
  const loadOf = (sessions: readonly number[]): Load => ({
    meanSessions: roundTo(sessions.reduce((sum, value) => sum + value, 0) / measured, 2),
    peakSessions: roundTo(maxOf(sessions) ?? 0, 2),
  });
  const waits = groupedBy(
    inRun.filter((insight) => insight.group === 'wait'),
    (insight) => insight.dimensions[INSIGHT_DIMENSIONS.waitName] ?? '',
  ).map((group) => ({ ...group, ...loadOf(group.sessions) }));
  const queriesOf = (group: Insight['group'], wait: string | null): QueryLoad[] =>
    groupedBy(
      inRun.filter(
        (insight) =>
          insight.group === group &&
          (wait === null || insight.dimensions[INSIGHT_DIMENSIONS.waitName] === wait),
      ),
      (insight) =>
        insight.dimensions[INSIGHT_DIMENSIONS.queryId] ?? JSON.stringify(insight.dimensions),
    )
      .map((one) => ({ ...one, ...loadOf(one.sessions) }))
      .sort(busiestFirst)
      .map((one) => ({
        statement: one.dimensions[INSIGHT_DIMENSIONS.queryStatement] ?? one.key,
        id: one.dimensions[INSIGHT_DIMENSIONS.queryId] ?? null,
        meanSessions: one.meanSessions,
        peakSessions: one.peakSessions,
      }));
  const keptFor = new Set(
    data.insights.flatMap((insight) =>
      insight.group === 'query-in-wait'
        ? (insight.dimensions[INSIGHT_DIMENSIONS.waitName] ?? [])
        : [],
    ),
  );
  const busiestWaits = waits.sort(busiestFirst).map((group) => ({
    wait: group.key,
    type: group.dimensions[INSIGHT_DIMENSIONS.waitType] ?? null,
    meanSessions: group.meanSessions,
    peakSessions: group.peakSessions,
  }));
  return {
    waits: busiestWaits,
    queries: queriesOf('query', null),
    statementsByWait:
      keptFor.size === 0
        ? null
        : busiestWaits
            .filter(({ wait }) => keptFor.has(wait))
            .map(({ wait }) => ({ wait, statements: queriesOf('query-in-wait', wait) })),
  };
}
