import { describe, expect, it } from 'vitest';
import type { MetricTarget } from '../raise.ts';
import { deploymentEventOrNull, serviceEventOrNull, taskInfoOf } from './ecs.ts';
import { insightsOf } from './insights.ts';
import { messageLine, touchesWindow } from './logs.ts';
import { metricsOfTarget } from './metrics.ts';
import { scalingEventOrNull } from './scaling.ts';

describe('metricsOfTarget', () => {
  const cluster: MetricTarget = {
    label: 'cluster',
    namespaces: ['AWS/ECS'],
    dimensions: { ClusterName: 'c' },
  };
  const service: MetricTarget = {
    label: 'service',
    namespaces: ['AWS/ECS'],
    dimensions: { ClusterName: 'c', ServiceName: 's' },
  };
  const cache: MetricTarget = {
    label: 'cache',
    namespaces: ['AWS/ElastiCache'],
    dimensions: { '*': 'valkey' },
  };
  const targets = [cluster, service, cache];
  const metric = (namespace: string, dimensions: Record<string, string>) => ({
    namespace,
    name: 'CPUUtilization',
    dimensions,
  });
  const found = [
    metric('AWS/ECS', { ClusterName: 'c' }),
    metric('AWS/ECS', { ClusterName: 'c', ServiceName: 's' }),
    metric('AWS/ECS', { ClusterName: 'other' }),
    metric('AWS/ElastiCache', { clusterId: 'valkey' }),
    metric('AWS/ElastiCache', { clusterId: 'else' }),
    metric('AWS/Lambda', { ClusterName: 'c' }),
  ];

  it('gives a service’s metrics to the service and not also to its cluster', () => {
    expect(metricsOfTarget(service, targets, found)).toEqual([found[1]]);
    expect(metricsOfTarget(cluster, targets, found)).toEqual([found[0]]);
  });

  it('picks a metric out by a dimension value alone when the target names no dimension', () => {
    expect(metricsOfTarget(cache, targets, found)).toEqual([found[3]]);
  });

  it('gives a namespace’s metrics, whatever their dimensions, to a target that names none', () => {
    const published: MetricTarget = { label: 'published', namespaces: ['Ari/App'], dimensions: {} };
    const own = [metric('Ari/App', {}), metric('Ari/App', { Task: 'send' })];

    expect(metricsOfTarget(published, [...targets, published], [...found, ...own])).toEqual(own);
  });
});

describe('what ECS says', () => {
  it('describes a task by when it ran, why it stopped, what it was started with and what capacity it had', () => {
    expect(
      taskInfoOf('load', {
        taskArn: 'arn:aws:ecs:ap-southeast-2:1:task/load/abc123',
        createdAt: new Date('2026-10-15T00:00:00.000Z'),
        startedAt: new Date('2026-10-15T00:00:30.000Z'),
        stoppingAt: new Date('2026-10-15T00:09:20.000Z'),
        stoppedAt: new Date('2026-10-15T00:10:00.000Z'),
        stopCode: 'SpotInterruption',
        stoppedReason: 'Spot',
        capacityProviderName: 'FARGATE_SPOT',
        containers: [{ exitCode: 0 }],
        overrides: {
          containerOverrides: [
            { name: 'generator', environment: [{ name: 'GENERATOR', value: '3' }] },
          ],
        },
      }),
    ).toEqual({
      taskId: 'abc123',
      cluster: 'load',
      createdAt: '2026-10-15T00:00:00.000Z',
      startedAt: '2026-10-15T00:00:30.000Z',
      stoppingAt: '2026-10-15T00:09:20.000Z',
      stoppedAt: '2026-10-15T00:10:00.000Z',
      stopCode: 'SpotInterruption',
      stoppedReason: 'Spot',
      exitCode: 0,
      capacityProvider: 'FARGATE_SPOT',
      environment: { GENERATOR: '3' },
    });
  });

  it('turns a service event into an event of the service at the time it was said', () => {
    expect(
      serviceEventOrNull('api', {
        id: 'e1',
        createdAt: new Date('2026-10-15T00:00:00.000Z'),
        message: 'has reached a steady state.',
      }),
    ).toEqual({
      at: '2026-10-15T00:00:00.000Z',
      source: 'ecs-service',
      resource: 'api',
      summary: 'has reached a steady state.',
      detail: { id: 'e1' },
    });
    expect(serviceEventOrNull('api', { message: 'no time' })).toBeNull();
  });

  it('turns a deployment into an event at the time it began, with its counts', () => {
    expect(
      deploymentEventOrNull('api', {
        id: 'ecs-svc/1',
        status: 'PRIMARY',
        rolloutState: 'COMPLETED',
        taskDefinition: 'api:7',
        desiredCount: 4,
        runningCount: 4,
        pendingCount: 0,
        failedTasks: 0,
        createdAt: new Date('2026-10-15T00:01:00.000Z'),
        updatedAt: new Date('2026-10-15T00:03:00.000Z'),
      }),
    ).toEqual({
      at: '2026-10-15T00:01:00.000Z',
      source: 'deployment',
      resource: 'api',
      summary: 'PRIMARY, rollout COMPLETED',
      detail: {
        id: 'ecs-svc/1',
        taskDefinition: 'api:7',
        desiredCount: 4,
        pendingCount: 0,
        runningCount: 4,
        failedTasks: 0,
        rolloutStateReason: null,
        updatedAt: '2026-10-15T00:03:00.000Z',
      },
    });
  });
});

describe('what the other services say', () => {
  it('turns a scaling decision into an event at the time it began', () => {
    expect(
      scalingEventOrNull('api', {
        ActivityId: 'a',
        ServiceNamespace: 'ecs',
        ResourceId: 'service/c/api',
        ScalableDimension: 'ecs:service:DesiredCount',
        Description: 'Setting desired count to 6.',
        Cause: 'monitor alarm TargetTracking-high in state ALARM',
        StartTime: new Date('2026-10-15T00:20:00.000Z'),
        EndTime: new Date('2026-10-15T00:21:00.000Z'),
        StatusCode: 'Successful',
      }),
    ).toEqual({
      at: '2026-10-15T00:20:00.000Z',
      source: 'scaling',
      resource: 'api',
      summary: 'Setting desired count to 6.',
      detail: {
        cause: 'monitor alarm TargetTracking-high in state ALARM',
        status: 'Successful',
        statusMessage: null,
        endedAt: '2026-10-15T00:21:00.000Z',
      },
    });
  });

  it('turns the minutes of one wait and of one query into insights, and leaves out a total', () => {
    const point = { Timestamp: new Date('2026-10-15T00:30:00.000Z'), Value: 0.5 };

    expect(
      insightsOf({
        Key: { Metric: 'db.load.avg', Dimensions: { 'db.wait_event.name': 'CPU' } },
        DataPoints: [point],
      }),
    ).toEqual([
      {
        group: 'wait',
        dimensions: { 'db.wait_event.name': 'CPU' },
        at: '2026-10-15T00:30:00.000Z',
        averageActiveSessions: 0.5,
      },
    ]);
    expect(
      insightsOf({
        Key: { Metric: 'db.load.avg', Dimensions: { 'db.sql_tokenized.statement': 'select 1' } },
        DataPoints: [point],
      })[0],
    ).toMatchObject({ group: 'query' });
    expect(insightsOf({ Key: { Metric: 'db.load.avg' }, DataPoints: [point] })).toEqual([]);
  });
});

describe('logs', () => {
  it('drops the newlines a message may end with, and keeps those inside it', () => {
    expect(messageLine('one\n\n')).toBe('one');
    expect(messageLine('at a\n  at b\n')).toBe('at a\n  at b');
  });

  it('leaves out only a stream that began after the window ended, because its last event time lags', () => {
    const window = { from: new Date(1_000), to: new Date(2_000) };

    expect(touchesWindow({ firstEventTimestamp: 500 }, window)).toBe(true);
    expect(touchesWindow({ firstEventTimestamp: 2_000 }, window)).toBe(true);
    expect(touchesWindow({}, window)).toBe(true);
    expect(touchesWindow({ firstEventTimestamp: 2_500 }, window)).toBe(false);
  });
});
