import { describe, expect, it } from 'vitest';
import { STARTED, appStateWith, at, exchangeWith, runDataWith } from '../../runData/testing.ts';
import { eachCopyColumns, gateColumns, jobsByTaskColumns } from './appColumns.ts';

const MINUTE_0 = Date.parse(STARTED);

/** Each gate column's figure in the run's first minute, by the column's name. */
function firstMinute(exchanges: ReturnType<typeof exchangeWith>[]): Record<string, number | null> {
  return Object.fromEntries(
    gateColumns(runDataWith({ exchanges })).map((column) => [column.name, column.at(MINUTE_0)]),
  );
}

describe('gateColumns', () => {
  it('counts each verdict the gate judged, and the share of waits that hit the limit', () => {
    expect(
      firstMinute([
        exchangeWith({ verdict: 'pass' }),
        exchangeWith({ verdict: 'fire', outcome: 'paused' }),
        exchangeWith({ verdict: 'pending', outcome: 'gate-pending' }),
        exchangeWith({ verdict: 'pass' }),
      ]),
    ).toMatchObject({
      gate_verdicts_pass: 2,
      gate_verdicts_fire: 1,
      gate_verdicts_pending: 1,
      gate_waits_at_limit_percent: 25,
    });
  });

  it('counts a verdict a retry replayed neither as a verdict nor as a wait', () => {
    expect(
      firstMinute([
        exchangeWith({ verdict: 'pending', outcome: 'gate-pending' }),
        exchangeWith({ trigger: 'retry', verdict: 'pass', verdictReplayed: true }),
      ]),
    ).toEqual({ gate_verdicts_pending: 1, gate_waits_at_limit_percent: 100 });
  });

  it('counts a client that left during the wait neither as a verdict nor as a wait', () => {
    expect(
      firstMinute([
        exchangeWith({ verdict: 'pass' }),
        exchangeWith({ verdict: null, outcome: 'gone', errorCode: 'client_gone' }),
      ]),
    ).toEqual({ gate_verdicts_pass: 1, gate_waits_at_limit_percent: 0 });
  });
});

describe('eachCopyColumns', () => {
  it('splits each figure by the copy that gave it, labelled by what the copy does', () => {
    const data = runDataWith({
      appStates: [
        appStateWith({ copy: '8536ff1a178f', pushStreamsOpen: 9_400, dbConnectionsWaiting: 159 }),
        appStateWith({ copy: '8536ff1a178f', at: at(20), pushStreamsOpen: 9_441 }),
        appStateWith({ copy: '1f6fcd6a677b', workerSlots: 16, workerSlotsBusy: 12 }),
      ],
    });
    const figures = Object.fromEntries(
      eachCopyColumns(data).map((column) => [column.name, column.at(MINUTE_0)]),
    );

    expect(figures).toMatchObject({
      copy_push_streams_open_api_8536ff1a: 9_441,
      copy_db_connections_waiting_api_8536ff1a: 159,
      copy_worker_slots_busy_worker_1f6fcd6a: 12,
      copy_worker_slots_busy_api_8536ff1a: null,
    });
  });
});

describe('jobsByTaskColumns', () => {
  it('counts the jobs of each task that started in the minute, and how long they ran on average', () => {
    const job = (task: string, durationMs: number) => ({
      copy: 'worker-1',
      task,
      jobId: `${task}-${durationMs}`,
      attempt: 1,
      queuedAt: at(10),
      startedAt: at(10),
      finishedAt: at(11),
      durationMs,
      outcome: 'succeeded' as const,
      errorClass: null,
      errorCode: null,
    });
    const figures = Object.fromEntries(
      jobsByTaskColumns(
        runDataWith({
          jobs: [job('judge', 60), job('judge', 80), job('fold', 40)],
        }),
      ).map((column) => [column.name, column.at(MINUTE_0)]),
    );

    expect(figures).toEqual({
      jobs_started_fold: 1,
      jobs_started_judge: 2,
      job_run_mean_ms_fold: 40,
      job_run_mean_ms_judge: 70,
    });
  });
});
