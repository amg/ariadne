import { describe, expect, it } from 'vitest';
import { AWS_METRIC_RESOURCES, LAYOUT } from '../../records/index.ts';
import { runFactsOf } from '../facts/index.ts';
import {
  ENDED,
  at,
  manifestWith,
  requestWith,
  runDataWith,
  sliceDataWith,
  sliceWith,
} from '../runData/testing.ts';
import { minuteTable } from '../table/index.ts';
import type { ResourceMetrics } from '../types.ts';
import { TOLERANCE, crossCheckChats, crossCheckLoadBalancer } from './crossChecks.ts';

type Data = ReturnType<typeof runDataWith>;
const chatChecks = (data: Data) => crossCheckChats(runFactsOf(data));
const balancerChecks = (data: Data) => crossCheckLoadBalancer(minuteTable(data), runFactsOf(data));

const exchange = (
  overrides: {
    firstTokenAfterMs?: number | null;
    outcome?: 'completed' | 'paused';
    arrivedAt?: string;
  } = {},
) => ({
  copy: null,
  userId: 'u',
  trigger: 'submit' as const,
  arrivedAt: overrides.arrivedAt ?? '2026-10-15T00:00:10.000Z',
  verdict: null,
  verdictReplayed: false,
  verdictAfterMs: null,
  firstTokenAfterMs: 'firstTokenAfterMs' in overrides ? (overrides.firstTokenAfterMs ?? null) : 50,
  endedAfterMs: 100,
  outcome: overrides.outcome ?? ('completed' as const),
  errorCode: null,
  assistantMessageId: null,
});

const slice = sliceWith();
const streamed = (count: number) =>
  Array.from({ length: count }, () => requestWith({ outcome: 'streamed' }));
const dataWith = (
  generatorChats: ReturnType<typeof requestWith>[],
  exchanges: ReturnType<typeof exchange>[] | null,
) => runDataWith({ slices: [sliceDataWith(slice, { requests: generatorChats })], exchanges });

describe('crossCheckChats', () => {
  it('agrees when the generators and the API count the same replies', () => {
    const checks = chatChecks(
      dataWith(
        streamed(50),
        Array.from({ length: 50 }, () => exchange()),
      ),
    );

    expect(checks[0]).toMatchObject({
      what: 'replies streamed',
      generators: 50,
      other: 50,
      against: 'the API',
      result: 'agree',
    });
  });

  it('counts a chat the gate paused on both sides', () => {
    const generators = [...streamed(10), requestWith({ outcome: 'paused' })];
    const api = [
      ...Array.from({ length: 10 }, () => exchange()),
      exchange({ firstTokenAfterMs: null, outcome: 'paused' }),
    ];

    expect(chatChecks(dataWith(generators, api))[1]).toMatchObject({
      what: 'chats paused by the gate',
      generators: 1,
      other: 1,
      result: 'agree',
    });
  });

  it('allows a small difference, and calls a larger one a mismatch', () => {
    const allowed = Math.max(TOLERANCE.atLeast, Math.ceil(200 * TOLERANCE.share));
    const apiLines = (count: number) => Array.from({ length: count }, () => exchange());

    expect(chatChecks(dataWith(streamed(200), apiLines(200 - allowed)))[0]?.result).toBe('agree');
    expect(chatChecks(dataWith(streamed(200), apiLines(200 - allowed - 1)))[0]).toMatchObject({
      result: 'mismatch',
      detail: `differ by ${allowed + 1}, more than the ${allowed} allowed`,
    });
  });

  it('calls it a mismatch when the API saw more than the generators did', () => {
    expect(
      chatChecks(
        dataWith(
          streamed(10),
          Array.from({ length: 30 }, () => exchange()),
        ),
      )[0]?.result,
    ).toBe('mismatch');
  });

  it('does not count a request that never reached the API as a reply', () => {
    const generators = [
      ...streamed(5),
      requestWith({ outcome: 'failed', status: null, errorCode: 'unreachable' }),
    ];

    expect(
      chatChecks(
        dataWith(
          generators,
          Array.from({ length: 5 }, () => exchange()),
        ),
      )[0]?.result,
    ).toBe('agree');
  });

  it('is not made, and says why, when a source is missing', () => {
    expect(chatChecks(dataWith(streamed(5), null))[0]).toMatchObject({
      result: 'not-made',
      detail: 'the API’s exchange lines are missing',
    });
    expect(chatChecks(dataWith([], [])).map(({ result }) => result)).toEqual(['agree', 'agree']);
    const noRequests = runDataWith({
      slices: [{ slice, requests: null, states: [] }],
      exchanges: [],
    });
    expect(chatChecks(noRequests)[0]).toMatchObject({
      result: 'not-made',
      detail: 'some generator’s request lines are missing',
    });
  });
});

const MINUTE_1 = '2026-10-15T00:01:00.000Z';
const MINUTE_2 = '2026-10-15T00:02:00.000Z';
const sent = (minute: string, count: number, status: number | null = 200) =>
  Array.from({ length: count }, (_, index) =>
    requestWith({
      kind: 'thread',
      startedAt: `${minute.slice(0, 17)}${String(index % 50).padStart(2, '0')}.100Z`,
      status,
      outcome: status === null ? 'failed' : 'ok',
    }),
  );

/** What the load balancer answered in one minute: `count` answers with `status`, from a service unless it says the load balancer gave them. */
type Counted = { minute: string; count: number; status?: number; byBalancer?: boolean };

/** The load balancer's CloudWatch metrics, as a run keeps them, holding what it answered. */
const balancerSaw = (counted: readonly Counted[]): ResourceMetrics => {
  const series = (name: string, holds: (entry: Required<Counted>) => boolean) => ({
    namespace: 'AWS/ApplicationELB',
    name,
    dimensions: { LoadBalancer: 'app/aws-prod-origin/50dc6c495c0c9188' },
    statistic: 'Sum',
    periodSeconds: 60,
    points: counted
      .map((entry) => ({ status: 200, byBalancer: false, ...entry }))
      .filter(holds)
      .map(({ minute, count }) => ({ at: minute, value: count })),
  });
  const ofClass = (who: 'Target' | 'ELB', hundreds: number) =>
    series(
      `HTTPCode_${who}_${hundreds}XX_Count`,
      ({ status, byBalancer }) =>
        byBalancer === (who === 'ELB') && Math.floor(status / 100) === hundreds,
    );
  return {
    resource: AWS_METRIC_RESOURCES.loadBalancer,
    path: LAYOUT.awsMetrics(AWS_METRIC_RESOURCES.loadBalancer),
    series: [
      series('RequestCount', ({ byBalancer }) => !byBalancer),
      ofClass('Target', 2),
      ofClass('Target', 4),
      ofClass('Target', 5),
      ofClass('ELB', 4),
      ofClass('ELB', 5),
    ],
  };
};

const awsRun = (requests: ReturnType<typeof requestWith>[], counted: readonly Counted[] | null) =>
  runDataWith({
    manifest: manifestWith({ target: 'aws-prod' }),
    slices: [sliceDataWith(slice, { requests })],
    awsMetrics: counted === null ? [] : [balancerSaw(counted)],
  });

const CHECKS = ['requests answered, by the minute', 'server errors (500s)', 'client errors (400s)'];

describe('crossCheckLoadBalancer', () => {
  it('needs no check for a run that has no load balancer, and says so', () => {
    expect(balancerChecks(runDataWith({ slices: [sliceDataWith(slice)] }))).toEqual([
      {
        what: 'every count set against the load balancer',
        against: 'the load balancer',
        generators: null,
        other: null,
        result: 'not-needed',
        detail: 'this run has no load balancer, so there is nothing to set the counts against',
      },
    ]);
  });

  it('agrees when every minute holds as many answers at the load balancer as at the generators', () => {
    const checks = balancerChecks(
      awsRun(
        [...sent(MINUTE_1, 100), ...sent(MINUTE_2, 50)],
        [
          { minute: MINUTE_1, count: 100 },
          { minute: MINUTE_2, count: 50 },
        ],
      ),
    );

    expect(checks.map(({ what, result }) => [what, result])).toEqual(
      CHECKS.map((what) => [what, 'agree']),
    );
    expect(checks[0]).toMatchObject({
      against: 'the load balancer',
      generators: 150,
      other: 150,
      detail: 'all 2 minutes within tolerance',
    });
  });

  it('counts a request in the minute it ended, as the load balancer does', () => {
    const long = sent(MINUTE_1, 100).map((line) => ({ ...line, totalMs: 60_000 }));

    const [perMinute] = balancerChecks(awsRun(long, [{ minute: MINUTE_2, count: 100 }]));

    expect(perMinute).toMatchObject({ result: 'agree', generators: 100, other: 100 });
  });

  it('does not count a request the generators never got an answer to', () => {
    const [perMinute] = balancerChecks(
      awsRun(
        [...sent(MINUTE_1, 100), ...sent(MINUTE_1, 30, null)],
        [{ minute: MINUTE_1, count: 100 }],
      ),
    );

    expect(perMinute).toMatchObject({ result: 'agree', generators: 100, other: 100 });
  });

  it('names the worst minute when one differs by more than the tolerance', () => {
    const [perMinute] = balancerChecks(
      awsRun(
        [...sent(MINUTE_1, 100), ...sent(MINUTE_2, 100)],
        [
          { minute: MINUTE_1, count: 100 },
          { minute: MINUTE_2, count: 80 },
        ],
      ),
    );

    expect(perMinute).toMatchObject({
      result: 'mismatch',
      generators: 200,
      other: 180,
      detail: `1 of 2 minutes differ by more than allowed; the worst, ${MINUTE_2}, has 100 from the generators and 80 at the load balancer`,
    });
  });

  it('calls a minute the load balancer never counted a mismatch', () => {
    const [perMinute] = balancerChecks(
      awsRun(sent(MINUTE_1, 40), [{ minute: MINUTE_2, count: 40 }]),
    );

    expect(perMinute?.result).toBe('mismatch');
  });

  it('allows a difference of up to a hundredth of the minute’s requests, and no more', () => {
    const allowed = Math.max(TOLERANCE.atLeast, Math.ceil(500 * TOLERANCE.share));
    const checked = (count: number) =>
      balancerChecks(awsRun(sent(MINUTE_1, 500), [{ minute: MINUTE_1, count }]))[0]?.result;

    expect(checked(500 - allowed)).toBe('agree');
    expect(checked(500 - allowed - 1)).toBe('mismatch');
  });

  it('sets the generators’ server errors against the load balancer’s, its own included', () => {
    const generators = [
      ...sent(MINUTE_1, 80),
      ...sent(MINUTE_1, 10, 502),
      ...sent(MINUTE_1, 10, 503),
    ];
    const agreeing = [
      { minute: MINUTE_1, count: 80 },
      { minute: MINUTE_1, count: 10, status: 502 },
      { minute: MINUTE_1, count: 10, status: 503, byBalancer: true },
    ];

    expect(balancerChecks(awsRun(generators, agreeing)).slice(0, 2)).toMatchObject([
      { generators: 100, other: 100, result: 'agree' },
      { what: 'server errors (500s)', generators: 20, other: 20, result: 'agree' },
    ]);
    expect(balancerChecks(awsRun(generators, [{ minute: MINUTE_1, count: 100 }]))[1]).toMatchObject(
      {
        generators: 20,
        other: 0,
        result: 'mismatch',
        detail: 'differ by 20, more than the 2 allowed',
      },
    );
  });

  it('sets the generators’ client errors against those of the services and of the load balancer', () => {
    const generators = [
      ...sent(MINUTE_1, 90),
      ...sent(MINUTE_1, 5, 429),
      ...sent(MINUTE_1, 5, 400),
    ];
    const counted = [
      { minute: MINUTE_1, count: 90 },
      { minute: MINUTE_1, count: 5, status: 429 },
      { minute: MINUTE_1, count: 5, status: 400, byBalancer: true },
    ];

    expect(balancerChecks(awsRun(generators, counted))[2]).toMatchObject({
      what: 'client errors (400s)',
      generators: 10,
      other: 10,
      result: 'agree',
    });
  });

  it('says why when the load balancer’s metrics are missing', () => {
    expect(balancerChecks(awsRun(sent(MINUTE_1, 5), null))).toEqual(
      CHECKS.map((what) => ({
        what,
        against: 'the load balancer',
        generators: null,
        other: null,
        result: 'not-made',
        detail: 'the load balancer’s metrics are missing',
      })),
    );
  });

  it('needs no comparison through Cloudflare, whose edge answers some requests itself', () => {
    const data = runDataWith({
      manifest: manifestWith({ target: 'aws-prod', loadPath: 'cloudflare' }),
      slices: [sliceDataWith(slice, { requests: sent(MINUTE_1, 5) })],
      awsMetrics: [balancerSaw([{ minute: MINUTE_1, count: 5 }])],
    });

    const checks = balancerChecks(data);

    expect(checks.map((check) => check.result)).toEqual(['not-needed']);
    expect(checks[0]?.detail).toContain('Cloudflare');
  });

  it('says why when a generator’s request lines are missing', () => {
    const data = runDataWith({
      manifest: manifestWith({ target: 'aws-prod' }),
      slices: [{ slice, requests: null, states: [] }],
      awsMetrics: [balancerSaw([{ minute: MINUTE_1, count: 5 }])],
    });

    expect(balancerChecks(data)[0]).toMatchObject({
      result: 'not-made',
      detail: 'some generator’s request lines are missing',
    });
  });
});

describe('cross-checks across a gap', () => {
  const lost = sliceWith({ down: [{ from: at(130), to: ENDED, reason: 'its generator stopped' }] });

  it('leaves the minutes a slice was down in out of both sides, and says how many', () => {
    const data = runDataWith({
      manifest: manifestWith({ target: 'aws-prod', slices: [lost] }),
      slices: [sliceDataWith(lost, { requests: [...sent(MINUTE_1, 100), ...sent(MINUTE_2, 40)] })],
      awsMetrics: [
        balancerSaw([
          { minute: MINUTE_1, count: 100 },
          { minute: MINUTE_2, count: 100 },
        ]),
      ],
    });

    const [perMinute, serverErrors] = balancerChecks(data);

    expect(perMinute).toMatchObject({
      result: 'agree',
      generators: 100,
      other: 100,
      detail: 'all 1 minutes within tolerance; left out as inside a gap: 1 minutes',
    });
    expect(serverErrors?.detail).toContain('left out as inside a gap: 1 minutes');
  });

  it('leaves out the chats that arrived while a slice was down, on both sides', () => {
    const data = runDataWith({
      manifest: manifestWith({ slices: [lost] }),
      slices: [sliceDataWith(lost, { requests: streamed(10) })],
      exchanges: [
        ...Array.from({ length: 10 }, () => exchange()),
        ...Array.from({ length: 6 }, () => exchange({ arrivedAt: at(150) })),
      ],
    });

    expect(chatChecks(data)[0]).toMatchObject({
      result: 'agree',
      generators: 10,
      other: 10,
      detail: 'within 2; left out as inside a gap: 6 exchanges from the API',
    });
  });

  it('compares everything when there is no gap', () => {
    const data = dataWith(streamed(10), [
      ...Array.from({ length: 10 }, () => exchange()),
      ...Array.from({ length: 6 }, () => exchange({ arrivedAt: at(150) })),
    ]);

    expect(chatChecks(data)[0]?.result).toBe('mismatch');
  });
});

describe('crossCheckLoadBalancer on a run of step50’s size', () => {
  it('sets a minute of two hundred thousand requests against the load balancer in a moment', () => {
    const requests = sent(MINUTE_1, 200_000);
    const started = performance.now();

    const checks = balancerChecks(awsRun(requests, [{ minute: MINUTE_1, count: 200_000 }]));

    expect(checks.map(({ result }) => result)).toEqual(['agree', 'agree', 'agree']);
    // Copying a minute's lines for every line takes minutes at this size.
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe('crossCheckLoadBalancer, push streams that broke off', () => {
  it('leaves a stream that broke off out of the generators’ count, as the load balancer never counts it, and says how many', () => {
    const isBrokenOff = Array.from({ length: 40 }, (_, user) =>
      requestWith({
        kind: 'push',
        user,
        startedAt: '2026-10-15T00:00:30.000Z',
        totalMs: 45_000,
        status: 200,
        outcome: 'failed',
      }),
    );

    const [perMinute] = balancerChecks(
      awsRun([...sent(MINUTE_1, 100), ...isBrokenOff], [{ minute: MINUTE_1, count: 100 }]),
    );

    expect(perMinute).toMatchObject({ result: 'agree', generators: 100, other: 100 });
    expect(perMinute?.detail).toContain('40 push streams that broke off');
  });
});
