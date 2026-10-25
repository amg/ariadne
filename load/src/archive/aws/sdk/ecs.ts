import {
  type Deployment,
  DescribeServicesCommand,
  DescribeTasksCommand,
  type ECSClient,
  type ServiceEvent,
  type Task,
  paginateListTasks,
} from '@aws-sdk/client-ecs';
import type { AwsEvent } from '../../../records/index.ts';
import type { TaskInfo } from '../../../types/archive.ts';
import type { RaiseSources } from '../sources.ts';
import { assertDescribed, instantOrNull, orUnavailable } from './failures.ts';

const GONE = ['ClusterNotFoundException'];

/** The most tasks or services ECS describes in one request. */
const TASKS_PER_REQUEST = 100;
const SERVICES_PER_REQUEST = 10;

/** A task as ECS describes it, kept to what an archive needs. */
export function taskInfoOf(cluster: string, task: Task): TaskInfo {
  const environment = (task.overrides?.containerOverrides ?? []).flatMap(
    (override) => override.environment ?? [],
  );
  return {
    taskId: (task.taskArn ?? '').split('/').pop() ?? '',
    cluster,
    createdAt: instantOrNull(task.createdAt),
    startedAt: instantOrNull(task.startedAt),
    stoppingAt: instantOrNull(task.stoppingAt),
    stoppedAt: instantOrNull(task.stoppedAt),
    stopCode: task.stopCode ?? null,
    stoppedReason: task.stoppedReason ?? null,
    exitCode: task.containers?.[0]?.exitCode ?? null,
    capacityProvider: task.capacityProviderName ?? null,
    environment: Object.fromEntries(
      environment.flatMap(({ name, value }) =>
        name === undefined || value === undefined ? [] : [[name, value]],
      ),
    ),
  };
}

/** What a service said of itself, as an event at the time it said it. */
export function serviceEventOrNull(service: string, event: ServiceEvent): AwsEvent | null {
  if (event.createdAt === undefined) return null;
  return {
    at: event.createdAt.toISOString(),
    source: 'ecs-service',
    resource: service,
    summary: event.message ?? '',
    detail: { id: event.id ?? null },
  };
}

/** A deployment as an event at the time it began. */
export function deploymentEventOrNull(service: string, deployment: Deployment): AwsEvent | null {
  if (deployment.createdAt === undefined) return null;
  return {
    at: deployment.createdAt.toISOString(),
    source: 'deployment',
    resource: service,
    summary: `${deployment.status ?? 'unknown'}, rollout ${deployment.rolloutState ?? 'unknown'}`,
    detail: {
      id: deployment.id ?? null,
      taskDefinition: deployment.taskDefinition ?? null,
      desiredCount: deployment.desiredCount ?? null,
      pendingCount: deployment.pendingCount ?? null,
      runningCount: deployment.runningCount ?? null,
      failedTasks: deployment.failedTasks ?? null,
      rolloutStateReason: deployment.rolloutStateReason ?? null,
      updatedAt: instantOrNull(deployment.updatedAt),
    },
  };
}

export function ecsSources(client: ECSClient): Pick<RaiseSources, 'tasks' | 'serviceEvents'> {
  return {
    async tasks(cluster) {
      return orUnavailable(`the cluster ${cluster}`, GONE, async () => {
        const arns: string[] = [];
        for (const desiredStatus of ['STOPPED', 'RUNNING'] as const) {
          for await (const page of paginateListTasks({ client }, { cluster, desiredStatus })) {
            arns.push(...(page.taskArns ?? []));
          }
        }
        const tasks: TaskInfo[] = [];
        for (let first = 0; first < arns.length; first += TASKS_PER_REQUEST) {
          const { tasks: described, failures } = await client.send(
            new DescribeTasksCommand({
              cluster,
              tasks: arns.slice(first, first + TASKS_PER_REQUEST),
            }),
          );
          assertDescribed(`tasks of ${cluster}`, failures);
          tasks.push(...(described ?? []).map((task) => taskInfoOf(cluster, task)));
        }
        return tasks;
      });
    },
    async serviceEvents(cluster, services) {
      return orUnavailable(`the cluster ${cluster}`, GONE, async () => {
        const events: (AwsEvent | null)[] = [];
        for (let first = 0; first < services.length; first += SERVICES_PER_REQUEST) {
          const { services: described, failures } = await client.send(
            new DescribeServicesCommand({
              cluster,
              services: services.slice(first, first + SERVICES_PER_REQUEST),
            }),
          );
          assertDescribed(`services of ${cluster}`, failures);
          for (const service of described ?? []) {
            const name = service.serviceName ?? '';
            events.push(
              ...(service.events ?? []).map((event) => serviceEventOrNull(name, event)),
              ...(service.deployments ?? []).map((deployment) =>
                deploymentEventOrNull(name, deployment),
              ),
            );
          }
        }
        return events.filter((event): event is AwsEvent => event !== null);
      });
    },
  };
}
