import { isInCatalogue, searchedMetricsIn } from '@ari/lib/metrics/searches';
import { describe, expect, it } from 'vitest';
import { measureOrNull, monitorQueries, serviceWordOf } from './queries.ts';

describe('monitorQueries', () => {
  it('asks only for signals of the catalogue, at the statistic it gives them', () => {
    const asked = monitorQueries({}).flatMap((query) => searchedMetricsIn(query.Expression));

    expect(asked).toHaveLength(monitorQueries({}).length);
    expect(asked.filter((metric) => !isInCatalogue(metric))).toEqual([]);
  });

  it('gives each query its own id and a label that says what it measures', () => {
    const queries = monitorQueries({});

    expect(new Set(queries.map((query) => query.Id)).size).toBe(queries.length);
    for (const query of queries) {
      expect(measureOrNull(query.Label.replace("${PROP('Dim.ServiceName')}", 'x'))).not.toBeNull();
    }
  });

  it('asks for the service of every per-service series, and of no other', () => {
    const labels = monitorQueries({}).map((query) => query.Label);

    expect(labels).toContain("running ${PROP('Dim.ServiceName')}");
    expect(labels).toContain('users');
  });

  it('narrows each stack figure to the resource of the stack it was given', () => {
    const narrowing = Object.fromEntries(
      monitorQueries({
        cluster: 'app-cluster',
        loadBalancer: 'app/origin/123',
        database: 'app-db',
      }).map((query) => [
        query.Id,
        / (\w+="(?:app-cluster|app\/origin\/123|app-db)")', /.exec(query.Expression)?.[1] ?? null,
      ]),
    );

    expect(narrowing).toEqual({
      users: null,
      chat: null,
      running: 'ClusterName="app-cluster"',
      desired: 'ClusterName="app-cluster"',
      cpu: 'ClusterName="app-cluster"',
      dbcpu: 'DBInstanceIdentifier="app-db"',
      dbload: 'DBInstanceIdentifier="app-db"',
      req: 'LoadBalancer="app/origin/123"',
      albp95: 'LoadBalancer="app/origin/123"',
    });
  });

  it('searches everywhere for a resource the scope lacks', () => {
    const expressions = monitorQueries({ cluster: 'app-cluster' }).map((q) => q.Expression);

    expect(expressions.find((e) => e.includes('RequestCount'))).not.toContain('LoadBalancer="');
  });
});

describe('measureOrNull', () => {
  it('reads the measure and the service from a label', () => {
    expect(measureOrNull('cpu aws-prod-app-ServicesWorkerService1A2B-xyz')).toEqual({
      measure: 'cpu',
      service: 'worker',
    });
    expect(measureOrNull('users')).toEqual({ measure: 'users', service: null });
  });

  it('takes no service from the series name CloudWatch adds to a measure that is not per service', () => {
    expect(
      measureOrNull('requests AWS/ApplicationELB app/ariaws-origi-3ycn/35b4 RequestCount'),
    ).toEqual({ measure: 'requests', service: null });
    expect(measureOrNull('users Ari/Load generator-1 UsersSignedIn')).toEqual({
      measure: 'users',
      service: null,
    });
  });

  it('knows no label it did not ask for', () => {
    expect(measureOrNull('memory api')).toBeNull();
  });
});

describe('serviceWordOf', () => {
  it('takes the word a generated name carries, in lower case', () => {
    expect(serviceWordOf('aws-prod-app-ServicesApiService9F-abc')).toBe('api');
  });

  it('keeps a name that carries none', () => {
    expect(serviceWordOf('Plain')).toBe('plain');
  });
});
