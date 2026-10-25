import { describe, expect, it } from 'vitest';
import type { AwsEvent, Insight } from '../../records/index.ts';
import { ENDED, STARTED, at, runDataWith } from '../runData/testing.ts';
import { insightsSummary } from './insights.ts';
import { markersOf } from './markers.ts';

const awsEvent = (source: AwsEvent['source'], seconds: number) => ({
  at: at(seconds),
  source,
  resource: 'AriAwsApp-ServicesWorkerService-1',
  summary: `${source} happened`,
  detail: {},
});

describe('markersOf', () => {
  it('marks generator launches and stops, scaling and deployments, oldest first, and nothing else', () => {
    const data = runDataWith({
      events: [
        { kind: 'run-started', at: STARTED },
        {
          kind: 'generator-stopped',
          at: at(170),
          generator: 0,
          attempt: 1,
          reason: 'finished',
          detail: null,
          toldToStopAt: null,
          stoppedForRunEnd: false,
          replacedByAttempt: null,
        },
        {
          kind: 'generator-launched',
          at: at(1),
          generator: 0,
          attempt: 1,
          firstUser: 0,
          userCount: 10,
          task: 'task-1',
          spot: true,
          planned: null,
        },
        { kind: 'run-ended', at: ENDED, outcome: 'finished' },
      ],
      awsEvents: [
        awsEvent('deployment', 90),
        awsEvent('scaling', 60),
        awsEvent('ecs-service', 61),
        awsEvent('task-stop', 171),
      ],
    });

    expect(markersOf(data).map((marker) => marker.what)).toEqual([
      'generator 0 launched on task-1 (spot) for users 0 to 9',
      'scaling AriAwsApp-ServicesWorkerService-1: scaling happened',
      'deployment AriAwsApp-ServicesWorkerService-1: deployment happened',
      'generator 0 stopped (finished)',
    ]);
  });

  it('calls a service by its label when its metrics say which name it had', () => {
    const data = runDataWith({
      awsEvents: [awsEvent('scaling', 60)],
      awsMetrics: [
        {
          resource: 'ecs-service-worker',
          path: 'metrics/aws/ecs-service-worker.jsonl',
          series: [
            {
              namespace: 'AWS/ECS',
              name: 'CPUUtilization',
              dimensions: { ClusterName: 'app', ServiceName: 'AriAwsApp-ServicesWorkerService-1' },
              statistic: 'Average',
              periodSeconds: 60,
              points: [],
            },
          ],
        },
      ],
    });

    expect(markersOf(data).map((marker) => marker.what)).toEqual([
      'scaling worker: scaling happened',
    ]);
  });
});

describe('insightsSummary', () => {
  const wait = (name: string, seconds: number, sessions: number): Insight => ({
    group: 'wait',
    dimensions: { 'db.wait_event.name': name, 'db.wait_event.type': 'IO' },
    at: at(seconds),
    averageActiveSessions: sessions,
  });

  it('puts the busiest waits first, by the sessions they held on average over the run', () => {
    const summary = insightsSummary(
      runDataWith({
        insights: [
          wait('CPU', 0, 0.1),
          wait('CPU', 60, 0.3),
          wait('IO:WALSync', 0, 0.4),
          wait('IO:WALSync', 60, 0.2),
        ],
      }),
    );

    expect(summary?.waits).toEqual([
      { wait: 'IO:WALSync', type: 'IO', meanSessions: 0.3, peakSessions: 0.4 },
      { wait: 'CPU', type: 'IO', meanSessions: 0.2, peakSessions: 0.3 },
    ]);
  });

  it('counts only the minutes of the run', () => {
    const summary = insightsSummary(
      runDataWith({ insights: [wait('CPU', -120, 5), wait('CPU', 60, 0.5), wait('CPU', 600, 5)] }),
    );

    expect(summary?.waits).toEqual([
      { wait: 'CPU', type: 'IO', meanSessions: 0.5, peakSessions: 0.5 },
    ]);
  });

  it('names a query by its statement', () => {
    const summary = insightsSummary(
      runDataWith({
        insights: [
          {
            group: 'query',
            dimensions: { 'db.sql_tokenized.id': 'A1', 'db.sql_tokenized.statement': 'commit' },
            at: at(0),
            averageActiveSessions: 0.25,
          },
        ],
      }),
    );

    expect(summary?.queries).toEqual([
      { statement: 'commit', id: 'A1', meanSessions: 0.25, peakSessions: 0.25 },
    ]);
  });

  it('is null for a run that kept no Performance Insights', () => {
    expect(insightsSummary(runDataWith())).toBeNull();
  });

  const statementIn = (waitName: string, statement: string, sessions: number): Insight => ({
    group: 'query-in-wait',
    dimensions: {
      'db.sql_tokenized.id': statement,
      'db.sql_tokenized.statement': statement,
      'db.wait_event.name': waitName,
    },
    at: at(0),
    averageActiveSessions: sessions,
  });

  it('lists the busiest statements behind each wait, the busiest wait first', () => {
    const summary = insightsSummary(
      runDataWith({
        insights: [
          wait('Lock:object', 0, 0.9),
          wait('LWLock:WALWrite', 0, 0.4),
          statementIn('Lock:object', 'lock table', 0.2),
          statementIn('Lock:object', 'insert spend', 0.7),
          statementIn('LWLock:WALWrite', 'commit', 0.4),
        ],
      }),
    );

    expect(summary?.statementsByWait).toEqual([
      {
        wait: 'Lock:object',
        statements: [
          { statement: 'insert spend', id: 'insert spend', meanSessions: 0.7, peakSessions: 0.7 },
          { statement: 'lock table', id: 'lock table', meanSessions: 0.2, peakSessions: 0.2 },
        ],
      },
      {
        wait: 'LWLock:WALWrite',
        statements: [{ statement: 'commit', id: 'commit', meanSessions: 0.4, peakSessions: 0.4 }],
      },
    ]);
    expect(summary?.queries).toEqual([]);
  });

  it('says the statements behind the waits were not kept, for a run that kept only the waits', () => {
    const summary = insightsSummary(runDataWith({ insights: [wait('CPU', 0, 0.1)] }));

    expect(summary?.statementsByWait).toBeNull();
  });
});

describe('insightsSummary, a wait whose statements were not kept', () => {
  it('leaves the wait out of the statements, rather than showing it with none', () => {
    const summary = insightsSummary(
      runDataWith({
        insights: [
          {
            group: 'wait',
            dimensions: { 'db.wait_event.name': 'CPU' },
            at: at(0),
            averageActiveSessions: 0.5,
          },
          {
            group: 'wait',
            dimensions: { 'db.wait_event.name': 'Lock:object' },
            at: at(0),
            averageActiveSessions: 0.9,
          },
          {
            group: 'query-in-wait',
            dimensions: {
              'db.sql_tokenized.id': 'S1',
              'db.sql_tokenized.statement': 'insert spend',
              'db.wait_event.name': 'Lock:object',
            },
            at: at(0),
            averageActiveSessions: 0.9,
          },
        ],
      }),
    );

    expect(summary?.statementsByWait?.map(({ wait }) => wait)).toEqual(['Lock:object']);
  });
});
