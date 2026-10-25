import { describe, expect, it } from 'vitest';
import {
  SHARES,
  SIGNALS,
  allSignals,
  namespacesOf,
  originOf,
  passLineOf,
  searchOf,
} from './catalogue.ts';
import { isInCatalogue, searchedMetricsIn } from './searches.ts';

describe('the signal catalogue', () => {
  it('holds no two signals that read the same series the same way', () => {
    const readings = allSignals().map((signal) =>
      JSON.stringify([
        signal.namespace,
        signal.name,
        signal.statistic,
        signal.dimensions,
        signal.where ?? {},
        signal.minute,
      ]),
    );

    expect(new Set(readings).size).toBe(readings.length);
  });

  it('gives the signals of one published metric the same unit and dimensions, so any of them can describe what is published', () => {
    const readings = new Map<string, Set<string>>();
    for (const { namespace, name, unit, dimensions } of allSignals().filter(
      (signal) => originOf(signal) !== 'aws',
    )) {
      const metric = `${namespace}/${name}`;
      readings.set(metric, (readings.get(metric) ?? new Set()).add(`${unit}|${dimensions}`));
    }

    for (const [metric, kinds] of readings) expect(kinds.size, metric).toBe(1);
  });

  it('says where each signal comes from', () => {
    expect(originOf(SIGNALS.load.requests)).toBe('generator line');
    expect(originOf(SIGNALS.app.jobsRun)).toBe('backend record');
    expect(originOf(SIGNALS.database.cpu)).toBe('aws');
  });

  it('holds the pass lines a run is judged by', () => {
    expect(passLineOf(SIGNALS.load.chatFirstByteP95)).toBe(2_500);
    expect(passLineOf(SHARES.signInFailures)).toBe(0.5);
    expect(passLineOf(SHARES.gateWaitsAtLimit)).toBe(0.5);
    expect(passLineOf(SHARES.generatorCpuBusiest)).toBe(70);
  });

  it('refuses the pass line of a signal that has none', () => {
    expect(() => passLineOf(SIGNALS.load.requests)).toThrow();
  });
});

describe('searchOf', () => {
  it('names the namespace, its dimensions and the metric', () => {
    expect(searchOf(SIGNALS.load.usersSignedIn)).toBe(
      '{Ari/Load,Generator} MetricName="UsersSignedIn"',
    );
  });

  it('adds what the signal itself requires, and what the caller narrows to', () => {
    expect(searchOf(SIGNALS.load.signInFailures)).toBe(
      '{Ari/Load,Kind} MetricName="Failures" Kind="signin"',
    );
    expect(
      searchOf(SIGNALS.service.cpuAverage, {
        exact: { ClusterName: 'app' },
        contains: { ServiceName: 'Api' },
      }),
    ).toBe(
      '{AWS/ECS,ClusterName,ServiceName} MetricName="CPUUtilization" ClusterName="app" ServiceName=Api',
    );
  });
});

describe('namespacesOf', () => {
  it('lists each namespace of a group once', () => {
    expect(namespacesOf(SIGNALS.service)).toEqual(['AWS/ECS', 'ECS/ContainerInsights']);
  });
});

describe('searchedMetricsIn', () => {
  it('finds each metric a search names, with its dimensions and statistic, whether or not its quotes are escaped', () => {
    const search = `SEARCH('${searchOf(SIGNALS.loadBalancer.requests)}', 'Sum', 60)`;

    const expected = [
      {
        namespace: 'AWS/ApplicationELB',
        dimensions: ['LoadBalancer'],
        name: 'RequestCount',
        statistic: 'Sum',
      },
    ];
    expect(searchedMetricsIn(search)).toEqual(expected);
    expect(searchedMetricsIn(JSON.stringify(search))).toEqual(expected);
  });
});

describe('isInCatalogue', () => {
  const cpu = {
    namespace: 'AWS/RDS',
    dimensions: ['DBInstanceIdentifier'],
    name: 'CPUUtilization',
    statistic: 'Maximum',
  };

  it('knows a metric the catalogue holds', () => {
    expect(isInCatalogue(cpu)).toBe(true);
  });

  it('refuses a statistic, a dimension or a name the catalogue does not hold', () => {
    expect(isInCatalogue({ ...cpu, statistic: 'p99' })).toBe(false);
    expect(isInCatalogue({ ...cpu, dimensions: [] })).toBe(false);
    expect(isInCatalogue({ ...cpu, name: 'Made-up' })).toBe(false);
  });
});
