import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../records/manifest.ts';
import type { Report } from '../records/report.ts';
import type { Attempt } from './attempts.ts';
import {
  type AttemptFacts,
  type ExpectedSource,
  type RequestFacts,
  checkAppRecords,
  checkChecksums,
  checkRequestCoverage,
  checkRequestTotals,
  checkServicesRecorded,
} from './selfChecks.ts';

const OPENED = '2026-10-15T00:00:00.000Z';
const CLOSED = '2026-10-15T00:01:00.000Z';

const started: Attempt = {
  generator: 0,
  attempt: 1,
  firstUser: 0,
  userCount: 5,
  task: 'pid-1',
  spot: false,
  startedAt: OPENED,
  stoppedAt: CLOSED,
  stoppedBecause: 'finished',
  stopDetail: null,
  toldToStopAt: null,
  stoppedForRunEnd: false,
  replacedByAttempt: null,
  planned: null,
};

const covering: RequestFacts = {
  present: true,
  count: 10,
  byKind: { chat: 6, push: 4 },
  firstStartedAt: '2026-10-15T00:00:02.000Z',
  lastEndedAt: '2026-10-15T00:00:59.000Z',
};

const report: Report = {
  runId: 'run-1',
  generator: 0,
  attempt: 1,
  startedAt: OPENED,
  endedAt: CLOSED,
  interrupted: false,
  requests: { total: 10, byKind: { chat: 6, push: 4 } },
  phases: null,
};

function attempt(
  overrides: Omit<Partial<AttemptFacts>, 'attempt'> & {
    attempt?: Partial<Attempt>;
  } = {},
) {
  const { attempt: attemptOverrides, ...rest } = overrides;
  return {
    attempt: { ...started, ...attemptOverrides },
    requests: covering,
    report,
    requestsPath: 'requests/generator-0.jsonl',
    ...rest,
  };
}

describe('checkRequestCoverage', () => {
  it('passes an attempt whose requests span its window', () => {
    expect(checkRequestCoverage([attempt()])).toEqual([]);
  });

  it('names the file of an attempt that has none', () => {
    const [finding] = checkRequestCoverage([
      attempt({ requests: { ...covering, present: false, count: 0 } }),
    ]);

    expect(finding).toMatchObject({
      check: 'request-coverage',
      path: 'requests/generator-0.jsonl',
    });
    expect(finding?.detail).toContain('is missing');
  });

  it('fails an attempt that had users and wrote no lines', () => {
    expect(
      checkRequestCoverage([
        attempt({ requests: { ...covering, count: 0, firstStartedAt: null } }),
      ]),
    ).toHaveLength(1);
  });

  it('excuses an attempt that was cut off before its first request, when its events say why', () => {
    const cutOff = attempt({
      attempt: { stoppedBecause: 'failed', stopDetail: 'killed' },
      requests: { ...covering, count: 0, firstStartedAt: null, lastEndedAt: null },
    });

    expect(checkRequestCoverage([cutOff])).toEqual([]);
  });

  it('accepts an attempt with no users and no lines', () => {
    expect(
      checkRequestCoverage([
        attempt({
          attempt: { userCount: 0 },
          requests: { ...covering, count: 0, firstStartedAt: null, lastEndedAt: null },
        }),
      ]),
    ).toEqual([]);
  });

  it('fails an attempt with no plan in its report whose first request came long after it launched', () => {
    const [finding] = checkRequestCoverage([
      attempt({ requests: { ...covering, firstStartedAt: '2026-10-15T00:00:30.000Z' } }),
    ]);

    expect(finding?.detail).toContain('after its window opened');
  });

  it('fails a finished attempt with no plan in its report whose requests stop long before it stopped', () => {
    const [finding] = checkRequestCoverage([
      attempt({ requests: { ...covering, lastEndedAt: '2026-10-15T00:00:20.000Z' } }),
    ]);

    expect(finding?.detail).toContain('before its window closed');
  });

  describe('an attempt whose report gives its plan as it ran', () => {
    const planned = (rampStartedAt: string, rampDownEndedAt: string): Report => ({
      ...report,
      phases: {
        ramp: { startedAt: rampStartedAt, endedAt: '2026-10-15T00:00:25.000Z' },
        hold: { startedAt: '2026-10-15T00:00:25.000Z', endedAt: rampDownEndedAt },
        rampDown: { startedAt: rampDownEndedAt, endedAt: rampDownEndedAt },
      },
    });

    it('measures its requests against its plan, so slow start-up and shutdown of its task are not counted', () => {
      expect(
        checkRequestCoverage([
          attempt({
            report: planned('2026-10-15T00:00:20.000Z', '2026-10-15T00:00:40.000Z'),
            requests: {
              ...covering,
              firstStartedAt: '2026-10-15T00:00:20.001Z',
              lastEndedAt: '2026-10-15T00:00:39.998Z',
            },
          }),
        ]),
      ).toEqual([]);
    });

    it('fails it when its first request came long after its ramp began', () => {
      const [finding] = checkRequestCoverage([
        attempt({
          report: planned(OPENED, '2026-10-15T00:00:59.000Z'),
          requests: { ...covering, firstStartedAt: '2026-10-15T00:00:30.000Z' },
        }),
      ]);

      expect(finding?.detail).toContain('after its window opened');
    });

    it('fails it when its requests stop long before its ramp-down ended', () => {
      const [finding] = checkRequestCoverage([
        attempt({
          report: planned('2026-10-15T00:00:02.000Z', '2026-10-15T00:00:59.000Z'),
          requests: { ...covering, lastEndedAt: '2026-10-15T00:00:20.000Z' },
        }),
      ]);

      expect(finding?.detail).toContain('before its window closed');
    });
  });

  describe('an attempt that was told to stop', () => {
    const interrupted = (requests: Partial<RequestFacts>) =>
      attempt({
        attempt: {
          startedAt: OPENED,
          stoppedAt: '2026-10-15T00:01:00.000Z',
          stoppedBecause: 'interrupted',
        },
        report: {
          ...report,
          interrupted: true,
          phases: {
            ramp: { startedAt: '2026-10-15T00:00:25.000Z', endedAt: '2026-10-15T00:00:40.000Z' },
            hold: { startedAt: '2026-10-15T00:00:40.000Z', endedAt: '2026-10-15T00:00:40.000Z' },
            rampDown: {
              startedAt: '2026-10-15T00:00:40.000Z',
              endedAt: '2026-10-15T00:00:42.000Z',
            },
          },
        },
        requests: { ...covering, ...requests },
      });

    it('is timed from its ramp, not from when its task was launched', () => {
      expect(
        checkRequestCoverage([interrupted({ firstStartedAt: '2026-10-15T00:00:25.500Z' })]),
      ).toEqual([]);
    });

    it('fails when its first request came long after its ramp began', () => {
      const [finding] = checkRequestCoverage([
        interrupted({ firstStartedAt: '2026-10-15T00:00:45.000Z' }),
      ]);

      expect(finding?.detail).toContain('after its window opened');
    });
  });

  it('excuses the end of an attempt the run stopped early', () => {
    expect(
      checkRequestCoverage([
        attempt({
          attempt: { stoppedBecause: 'guard' },
          requests: { ...covering, lastEndedAt: '2026-10-15T00:00:20.000Z' },
        }),
      ]),
    ).toEqual([]);
  });
});

describe('checkRequestTotals', () => {
  it('passes lines that match the report in all and by kind', () => {
    expect(checkRequestTotals([attempt()])).toEqual([]);
  });

  it('fails when the lines found are fewer than the report says were written', () => {
    const [finding] = checkRequestTotals([attempt({ requests: { ...covering, count: 9 } })]);

    expect(finding).toMatchObject({ check: 'request-totals' });
    expect(finding?.detail).toContain('reports 10 requests; 9 lines were found');
  });

  it('fails a kind that disagrees even when the total agrees', () => {
    const findings = checkRequestTotals([
      attempt({ requests: { ...covering, byKind: { chat: 5, push: 5 } } }),
    ]);

    expect(findings.map((finding) => finding.detail)).toEqual([
      expect.stringContaining('reports 6 chat requests; 5 lines'),
      expect.stringContaining('reports 4 push requests; 5 lines'),
    ]);
  });

  it('has nothing to compare for an attempt that never lived to report', () => {
    expect(checkRequestTotals([attempt({ report: null })])).toEqual([]);
  });
});

describe('checkServicesRecorded', () => {
  const logs: ExpectedSource = { service: 'backend', kind: 'logs', path: 'logs/backend.log' };
  const metrics: ExpectedSource = {
    service: 'host',
    kind: 'metrics',
    path: 'metrics/host.jsonl',
  };

  it('passes services whose logs exist and whose metrics have records in the window', () => {
    expect(
      checkServicesRecorded([logs, metrics], (source) => ({
        present: true,
        recordsInWindow: source.kind === 'logs' ? null : 12,
      })),
    ).toEqual([]);
  });

  it('names the logs of a service that left none', () => {
    const [finding] = checkServicesRecorded([logs], () => ({
      present: false,
      recordsInWindow: null,
    }));

    expect(finding).toMatchObject({ check: 'services-recorded', path: 'logs/backend.log' });
  });

  it('fails metrics that hold nothing inside the window', () => {
    const [finding] = checkServicesRecorded([metrics], () => ({
      present: true,
      recordsInWindow: 0,
    }));

    expect(finding?.detail).toContain('no record inside the run');
  });
});

describe('checkChecksums', () => {
  const entry: FileEntry = { path: 'a.jsonl', size: 3, sha256: 'aa' };

  it('passes files that hold what was written', () => {
    expect(checkChecksums([entry], () => ({ ...entry }))).toEqual([]);
  });

  it('fails a file that is gone', () => {
    expect(checkChecksums([entry], () => null)[0]?.detail).toContain('is gone');
  });

  it('fails a file whose checksum changed, and one whose size did', () => {
    expect(checkChecksums([entry], () => ({ ...entry, sha256: 'bb' }))).toHaveLength(1);
    expect(checkChecksums([entry], () => ({ ...entry, size: 4 }))).toHaveLength(1);
  });
});

describe('checkAppRecords', () => {
  const whole: Parameters<typeof checkAppRecords>[0] = {
    exchanges: { count: 2, streamed: 2 },
    jobs: 1,
    states: 1,
    chatsStreamed: 2,
  };

  it('passes a run with a line for every chat that streamed, and jobs and state beside them', () => {
    expect(checkAppRecords(whole)).toEqual([]);
  });

  it('passes an exchange line for a chat the generators did not see stream, as well', () => {
    expect(checkAppRecords({ ...whole, exchanges: { count: 3, streamed: 2 } })).toEqual([]);
  });

  it('names each file that is missing', () => {
    const found = checkAppRecords({ ...whole, exchanges: null, jobs: null });

    expect(found).toMatchObject([
      { check: 'app-records', path: 'app/exchanges.jsonl' },
      { check: 'app-records', path: 'app/jobs.jsonl' },
    ]);
    expect(found[0]?.detail).toContain('are missing');
  });

  it('fails when the API wrote fewer lines of streamed replies than the generators saw', () => {
    const [finding] = checkAppRecords({ ...whole, exchanges: { count: 1, streamed: 1 } });

    expect(finding).toMatchObject({ check: 'app-records', path: 'app/exchanges.jsonl' });
    expect(finding?.detail).toContain('saw 2 chats stream');
  });

  it('does not count an exchange line of a reply that never streamed', () => {
    expect(checkAppRecords({ ...whole, exchanges: { count: 2, streamed: 1 } })).toHaveLength(1);
  });

  it('fails a run with streamed chats and no job line', () => {
    const [finding] = checkAppRecords({ ...whole, jobs: 0 });

    expect(finding).toMatchObject({ check: 'app-records', path: 'app/jobs.jsonl' });
  });

  it('accepts no jobs where nothing streamed', () => {
    expect(
      checkAppRecords({
        ...whole,
        exchanges: { count: 0, streamed: 0 },
        jobs: 0,
        chatsStreamed: 0,
      }),
    ).toEqual([]);
  });

  it('fails a backend that wrote no state line', () => {
    expect(checkAppRecords({ ...whole, states: 0 })).toMatchObject([
      { check: 'app-records', path: 'app/state.jsonl' },
    ]);
  });
});
