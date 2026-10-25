import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { appRequestRecords, appStateRecords, exchangeRecords, jobRecords } from './appRecords.ts';
import { eventRecords } from './event.ts';
import { RUN_FOLDER_VERSION, readManifest } from './manifest.ts';
import { reportRecords } from './report.ts';
import { requestRecords, stateRecords } from './request.ts';
import { hostSampleRecords } from './samples.ts';
import { InvalidRecordLine, type RecordKind, UnknownSchemaVersion } from './versioned.ts';

const at = '2026-10-15T00:00:00.123Z';

const request = {
  run: 'run-1',
  generator: 0,
  attempt: 1,
  user: 4,
  kind: 'chat',
  startedAt: at,
  firstByteMs: 120.5,
  totalMs: 900,
  status: 200,
  outcome: 'streamed',
  errorCode: null,
};

const report = {
  runId: 'run-1',
  generator: 0,
  attempt: 1,
  startedAt: at,
  endedAt: at,
  interrupted: false,
  requests: { total: 1, byKind: { chat: 1 } },
  phases: null,
};

const manifest = {
  version: RUN_FOLDER_VERSION,
  runId: 'run-1',
  step: 'home-smoke',
  config: { users: 2 },
  target: 'cubi-dev',
  loadPath: 'direct',
  images: {},
  commits: { app: { sha: 'abc', dirty: false }, harness: { sha: 'abc', dirty: false } },
  startedAt: at,
  endedAt: at,
  trailingEndsAt: null,
  limits: { maxHostCpuPercent: 70 },
  slices: [
    {
      generator: 0,
      firstUser: 0,
      userCount: 2,
      startedAt: at,
      endedAt: at,
      hold: { from: at, to: at },
      down: [{ from: at, to: at, reason: 'its generator stopped' }],
      attempts: [
        {
          attempt: 1,
          task: 'pid-1',
          spot: false,
          startedAt: at,
          stoppedAt: at,
          stoppedBecause: 'interrupted',
          stopDetail: null,
          toldToStopAt: null,
          stoppedForRunEnd: false,
        },
      ],
    },
  ],
  files: [{ path: 'requests/a.jsonl', size: 3, sha256: 'ff' }],
  seal: { status: 'complete', sealedAt: at },
};

/** A valid example of each kind of record, and a broken one. */
const examples: [RecordKind<z.ZodType>, unknown, unknown][] = [
  [requestRecords, request, { ...request, outcome: 'maybe' }],
  [
    stateRecords,
    {
      run: 'run-1',
      generator: 0,
      attempt: 1,
      at,
      usersSignedIn: 3,
      pushStreamsOpen: 3,
      chattersActive: 2,
    },
    { run: 'run-1', at },
  ],
  [reportRecords, report, { ...report, requests: undefined }],
  [
    exchangeRecords,
    {
      copy: 'api-1',
      userId: 'u1',
      trigger: 'submit',
      arrivedAt: at,
      verdict: 'pass',
      verdictReplayed: false,
      verdictAfterMs: 30.5,
      firstTokenAfterMs: 410,
      endedAfterMs: 900.2,
      outcome: 'completed',
      errorCode: null,
      assistantMessageId: 'm1',
    },
    { userId: 'u1', outcome: 'completed' },
  ],
  [
    jobRecords,
    {
      copy: 'worker-1',
      task: 'driftGateJudgeArrival',
      jobId: '12',
      attempt: 1,
      queuedAt: at,
      startedAt: at,
      finishedAt: at,
      durationMs: 14.2,
      outcome: 'succeeded',
      errorClass: null,
      errorCode: null,
    },
    { task: 'driftGateJudgeArrival', outcome: 'shrugged' },
  ],
  [
    appRequestRecords,
    {
      copy: 'api-1',
      endedAt: at,
      method: 'GET',
      route: '/api/threads/:threadId',
      statusCode: 200,
      durationMs: 12.4,
    },
    { endedAt: at, method: 'GET', route: 7 },
  ],
  [
    appStateRecords,
    {
      copy: 'worker-1',
      at,
      pushStreamsOpen: 4,
      oldestJobWaitMs: 120,
      eventLoopDelayP99Ms: 8.5,
      heapUsedBytes: 100,
      residentBytes: 300,
      dbConnectionsInUse: 3,
      dbConnectionsWaiting: 0,
      workerSlotsBusy: 2,
      workerSlots: 16,
      pushBusFailures: 0,
    },
    { at, pushStreamsOpen: 1.5, oldestJobWaitMs: 0 },
  ],
  [
    hostSampleRecords,
    {
      at,
      cpuPercent: 3,
      perCorePercent: [3],
      memoryAvailableBytes: 1,
      memoryUsedPercent: 40,
      swapUsedBytes: 0,
      swapInBytes: 0,
      swapOutBytes: 0,
      loadAverage1: 0.4,
    },
    { at },
  ],
  [
    eventRecords,
    { kind: 'guard-tripped', at, line: 'host-cpu', observed: 80, limit: 70, message: 'm' },
    { kind: 'nonsense', at },
  ],
];

describe.each(examples)('the $0.name records', (kind, valid, broken) => {
  it('accepts a record of its kind', () => {
    expect(kind.read(valid)).toEqual(valid);
  });

  it('refuses a record that does not match the schema', () => {
    expect(() => kind.read(broken)).toThrow();
  });

  it('reads a file of lines, skipping blank ones', () => {
    const text = `${JSON.stringify(valid)}\n\n${JSON.stringify(valid)}\n`;
    expect(kind.readLines(text)).toEqual([valid, valid]);
  });

  it('names the line of a file that does not validate', () => {
    const text = `${JSON.stringify(valid)}\n${JSON.stringify(broken)}\n`;
    expect(() => kind.readLines(text)).toThrow(/Line 2/);
    expect(() => kind.readLines('not json')).toThrow(InvalidRecordLine);
  });
});

describe('readManifest', () => {
  it('reads the manifest of a run folder of the version it knows', () => {
    expect(readManifest(JSON.stringify(manifest)).runId).toBe('run-1');
  });

  it('refuses a run folder of a version it does not know, whatever else it holds', () => {
    expect(() => readManifest(JSON.stringify({ ...manifest, version: 1 }))).toThrow(
      UnknownSchemaVersion,
    );
    expect(() => readManifest('{}')).toThrow(UnknownSchemaVersion);
  });

  it('refuses a manifest that does not match the schema', () => {
    const incomplete = { ...manifest, seal: { status: 'incomplete', sealedAt: at, reasons: [] } };
    expect(() => readManifest(JSON.stringify(incomplete))).toThrow();
  });
});

describe('the report schema', () => {
  it('accepts the phases a generator that held users reports', () => {
    const stretch = { startedAt: at, endedAt: at };
    const phases = { ramp: stretch, hold: stretch, rampDown: stretch };
    expect(reportRecords.read({ ...report, phases }).phases).toEqual(phases);
  });
});

describe('a report that does not say whether its generator was interrupted', () => {
  it('reads as one that was not', () => {
    const { interrupted: _, ...old } = report;

    expect(reportRecords.read(old).interrupted).toBe(false);
  });
});
