import { isPublishedInCatalogue, publishedMetricsIn } from '@ari/lib/metrics/searches';
import { describe, expect, it } from 'vitest';
import type { RequestLine, StateLine } from '../records/index.ts';
import { requestLineText, stateLineText } from './lines.ts';

const AT = new Date('2026-10-15T00:00:01.000Z');

const request: RequestLine = {
  run: 'run-1',
  generator: 2,
  attempt: 1,
  user: 7,
  kind: 'chat',
  startedAt: '2026-10-15T00:00:00.123Z',
  firstByteMs: 120.5,
  totalMs: 900,
  status: 200,
  outcome: 'streamed',
  errorCode: null,
};

const state: StateLine = {
  run: 'run-1',
  generator: 2,
  attempt: 1,
  at: '2026-10-15T00:00:05.000Z',
  usersSignedIn: 40,
  pushStreamsOpen: 38,
  chattersActive: 4,
};

const published = (text: string) => JSON.parse(text);

describe('requestLineText', () => {
  it('follows a marker with the record where metrics are not published', () => {
    expect(requestLineText({ line: request, publishMetrics: false, at: AT })).toBe(
      `REQUEST ${JSON.stringify(request)}`,
    );
  });

  it('carries the record and the figures of a chat that streamed, on one JSON line the record leads', () => {
    const text = requestLineText({ line: request, publishMetrics: true, at: AT });
    const line = published(text);

    expect(text.startsWith('{"request":')).toBe(true);
    expect(line).toHaveProperty('_aws.Timestamp', AT.getTime());
    expect(line).toMatchObject({
      request,
      Kind: 'chat',
      Requests: 1,
      ChatFirstByteMs: 120.5,
    });
    expect(line).toHaveProperty('Failures', 0);
  });

  it('counts a failed request by its kind and gives it no first byte', () => {
    const failed: RequestLine = { ...request, kind: 'signin', outcome: 'failed', status: 500 };
    const line = published(requestLineText({ line: failed, publishMetrics: true, at: AT }));

    expect(line).toMatchObject({ Kind: 'signin', Requests: 1, Failures: 1 });
    expect(line).not.toHaveProperty('ChatFirstByteMs');
  });

  it('gives a chat that did not stream no first byte', () => {
    const paused: RequestLine = { ...request, outcome: 'paused' };

    expect(
      published(requestLineText({ line: paused, publishMetrics: true, at: AT })),
    ).not.toHaveProperty('ChatFirstByteMs');
  });
});

describe('the metrics a generator publishes', () => {
  it('are signals of the catalogue, with the unit and dimensions it gives them', () => {
    const lines = [
      published(requestLineText({ line: request, publishMetrics: true, at: AT })),
      published(
        requestLineText({
          line: { ...request, kind: 'signin', outcome: 'failed' },
          publishMetrics: true,
          at: AT,
        }),
      ),
      published(stateLineText(state, true)),
    ];
    const metrics = lines.flatMap(publishedMetricsIn);

    expect(metrics.map(({ name }) => name).sort()).toEqual([
      'ChatFirstByteMs',
      'ChattersActive',
      'Failures',
      'Failures',
      'PushStreamsOpen',
      'Requests',
      'Requests',
      'UsersSignedIn',
    ]);
    expect(metrics.filter((metric) => !isPublishedInCatalogue(metric))).toEqual([]);
  });
});

describe('stateLineText', () => {
  it('follows a marker with the record where metrics are not published', () => {
    expect(stateLineText(state, false)).toBe(`STATE ${JSON.stringify(state)}`);
  });

  it('carries the levels under the generator’s number', () => {
    expect(published(stateLineText(state, true))).toMatchObject({
      state,
      Generator: '2',
      UsersSignedIn: 40,
      PushStreamsOpen: 38,
      ChattersActive: 4,
    });
  });
});
