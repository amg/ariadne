import { allSignals, originOf } from '@ari/lib/metrics/catalogue';
import { describe, expect, it } from 'vitest';
import { LAYOUT } from '../../records/index.ts';
import { expectedSourcesOf, metricTargetsOf } from './raise.ts';
import { raise } from './testing.ts';

describe('metricTargetsOf', () => {
  it('has a target for each service, the clusters, the load balancer and its target groups, the database, the cache and the Fargate usage', () => {
    expect(metricTargetsOf(raise).map((target) => target.label)).toEqual([
      'ecs-cluster-app',
      'ecs-cluster-generator',
      'ecs-service-api',
      'ecs-service-worker',
      'ecs-service-auth',
      'ecs-service-mock',
      'ecs-service-web',
      'load-balancer',
      'target-group-api',
      'target-group-web',
      'database',
      'cache',
      'fargate-usage',
    ]);
  });

  it('keeps the metrics of every AWS namespace the catalogue reads, so that a run can be rebuilt from its folder', () => {
    const kept = new Set(metricTargetsOf(raise).flatMap((target) => target.namespaces));
    const read = new Set(
      allSignals()
        .filter((signal) => originOf(signal) === 'aws')
        .map(({ namespace }) => namespace),
    );

    expect([...read].filter((namespace) => !kept.has(namespace))).toEqual([]);
  });

  it('gives no two targets the same label, because the label names the file', () => {
    const labels = metricTargetsOf(raise).map((target) => target.label);

    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('expectedSourcesOf', () => {
  it('expects the logs of the API, the worker and auth, every service’s metrics, and the database’s, the cache’s and the load balancer’s', () => {
    const expected = expectedSourcesOf(raise);

    expect(expected).toContainEqual({
      service: 'api',
      kind: 'logs',
      path: LAYOUT.processLog('api'),
    });
    expect(expected).toContainEqual({
      service: 'api',
      kind: 'metrics',
      path: LAYOUT.awsMetrics('ecs-service-api'),
    });
    expect(expected.map((source) => source.service)).toEqual(
      expect.arrayContaining(['postgres', 'cache', 'load balancer']),
    );
    expect(
      expected.filter((source) => source.kind === 'logs').map((source) => source.service),
    ).toEqual(['api', 'worker', 'auth']);
    expect(expected).toHaveLength(3 + raise.services.length + 3);
  });
});
