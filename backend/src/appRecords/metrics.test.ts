import { isPublishedInCatalogue, publishedMetricsIn } from '@ari/lib/metrics/searches';
import { stateRecordOf } from '@test/appRecords';
import { describe, expect, it } from 'vitest';
import { metricFieldsOf } from './metrics';
import type { AppRecord } from './records';

const AT = new Date('2026-01-02T03:04:05.678Z');

const exchange = (changes: Partial<Extract<AppRecord, { kind: 'exchange' }>>): AppRecord => ({
  kind: 'exchange',
  copy: 't1',
  userId: 'u1',
  trigger: 'submit',
  arrivedAt: '2026-01-02T03:04:00.000Z',
  verdict: 'pass',
  verdictReplayed: false,
  verdictAfterMs: 120,
  firstTokenAfterMs: 800,
  endedAfterMs: 2_000,
  outcome: 'completed',
  errorCode: null,
  assistantMessageId: 'm1',
  ...changes,
});

const metricNames = (fields: Record<string, unknown>) => {
  const aws = fields._aws as { CloudWatchMetrics: { Metrics: { Name: string }[] }[] } | undefined;
  return (aws?.CloudWatchMetrics ?? []).flatMap((set) => set.Metrics.map((metric) => metric.Name));
};

describe('metricFieldsOf', () => {
  it('publishes only metrics of the catalogue, with the unit and dimensions it gives them', () => {
    const job: AppRecord = {
      kind: 'job',
      copy: 't1',
      task: 'analyse-thread',
      jobId: '7',
      attempt: 1,
      queuedAt: '2026-01-02T03:04:04.000Z',
      startedAt: '2026-01-02T03:04:04.250Z',
      finishedAt: '2026-01-02T03:04:05.000Z',
      durationMs: 750,
      outcome: 'succeeded',
      errorClass: null,
      errorCode: null,
    };
    const state = stateRecordOf({
      pushStreamsOpen: 1,
      oldestJobWaitMs: 1,
      eventLoopDelayP99Ms: 1,
      heapUsedBytes: 1,
      residentBytes: 1,
      dbConnectionsInUse: 1,
      dbConnectionsWaiting: 1,
      workerSlotsBusy: 1,
      pushBusFailures: 1,
    });
    const published = [
      state,
      job,
      exchange({ verdict: 'pending', outcome: 'gate-pending' }),
    ].flatMap((record) => publishedMetricsIn(metricFieldsOf(record, AT)));

    expect(published).toHaveLength(9 + 2 + 2);
    expect(published.filter((metric) => !isPublishedInCatalogue(metric))).toEqual([]);
  });

  it('publishes the push streams and the queue wait that a state record measures', () => {
    const fields = metricFieldsOf(stateRecordOf({ pushStreamsOpen: 240, oldestJobWaitMs: 90 }), AT);

    expect(fields).toMatchObject({ PushStreamsOpen: 240, QueueWaitMs: 90 });
  });

  it('publishes what a state record says of how loaded the copy is', () => {
    const fields = metricFieldsOf(
      stateRecordOf({
        eventLoopDelayP99Ms: 42.5,
        heapUsedBytes: 100,
        residentBytes: 300,
        dbConnectionsInUse: 7,
        dbConnectionsWaiting: 2,
        workerSlotsBusy: 16,
        pushBusFailures: 3,
      }),
      AT,
    );

    expect(fields).toMatchObject({
      EventLoopDelayP99Ms: 42.5,
      HeapUsedBytes: 100,
      ResidentBytes: 300,
      DbConnectionsInUse: 7,
      DbConnectionsWaiting: 2,
      WorkerSlotsBusy: 16,
      PushBusFailures: 3,
    });
    expect(JSON.stringify(fields)).toContain('"Unit":"Bytes"');
  });

  it('leaves out what a state record does not measure', () => {
    const fields = metricFieldsOf(stateRecordOf({ pushStreamsOpen: 240 }), AT);

    expect(metricNames(fields)).toEqual(['PushStreamsOpen']);
    expect(fields).not.toHaveProperty('QueueWaitMs');
  });

  it('counts a job by its task and publishes how long it waited to start', () => {
    const fields = metricFieldsOf(
      {
        kind: 'job',
        copy: 't1',
        task: 'analyse-thread',
        jobId: '7',
        attempt: 1,
        queuedAt: '2026-01-02T03:04:04.000Z',
        startedAt: '2026-01-02T03:04:04.250Z',
        finishedAt: '2026-01-02T03:04:05.000Z',
        durationMs: 750,
        outcome: 'succeeded',
        errorClass: null,
        errorCode: null,
      },
      AT,
    );

    expect(fields).toMatchObject({ Task: 'analyse-thread', JobsRun: 1, JobWaitMs: 250 });
  });

  it('leaves out the wait of a job whose moments cannot be read', () => {
    const fields = metricFieldsOf(
      {
        kind: 'job',
        copy: 't1',
        task: 'analyse-thread',
        jobId: '7',
        attempt: 1,
        queuedAt: 'not a moment',
        startedAt: '2026-01-02T03:04:04.250Z',
        finishedAt: '2026-01-02T03:04:05.000Z',
        durationMs: 750,
        outcome: 'succeeded',
        errorClass: null,
        errorCode: null,
      },
      AT,
    );

    expect(metricNames(fields)).toEqual(['JobsRun']);
  });

  it('counts a gate verdict by its outcome', () => {
    expect(metricFieldsOf(exchange({ verdict: 'fire' }), AT)).toMatchObject({
      Verdict: 'fire',
      GateVerdicts: 1,
    });
  });

  it('counts a gate wait that hit its limit', () => {
    const fields = metricFieldsOf(exchange({ verdict: 'pending', outcome: 'gate-pending' }), AT);

    expect(fields).toMatchObject({ Verdict: 'pending', GateVerdicts: 1, GateWaitsAtLimit: 1 });
  });

  it('publishes a zero wait at the limit for a verdict that did not wait', () => {
    const fields = metricFieldsOf(exchange({ verdict: 'pass' }), AT);

    expect(fields).toMatchObject({ GateVerdicts: 1, GateWaitsAtLimit: 0 });
  });

  it('publishes nothing for a request that never waited on the gate', () => {
    const fields = metricFieldsOf(exchange({ verdict: null, outcome: 'refused' }), AT);

    expect(fields).toEqual({});
  });

  it('publishes nothing for a client that left during the gate wait', () => {
    const fields = metricFieldsOf(exchange({ verdict: null, outcome: 'gone' }), AT);

    expect(fields).toEqual({});
  });

  it('counts no verdict and no wait for a retry that replayed a stored verdict', () => {
    const fields = metricFieldsOf(
      exchange({ trigger: 'retry', verdict: 'fire', verdictReplayed: true }),
      AT,
    );

    expect(fields).toEqual({});
  });
});
