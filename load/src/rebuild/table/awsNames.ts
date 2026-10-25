import { AWS_METRIC_RESOURCES } from '../../records/index.ts';
import type { RunData } from '../types.ts';

/** What every service's file name, and every target group's, starts with: the name of one with no label. */
const SERVICE_PREFIX = AWS_METRIC_RESOURCES.service('');
const TARGET_GROUP_PREFIX = AWS_METRIC_RESOURCES.targetGroup('');

/** What a service's ECS events say when it puts a task behind a target group, naming the group by its ARN. */
const REGISTERED_IN = /registered \d+ targets? in \(target-group arn:[^)]*?targetgroup\/([^/)]+)\//;

/** The label of the service a file of CloudWatch metrics belongs to, such as `api`; null for any other file. */
export function serviceLabelOrNull(resource: string) {
  return resource.startsWith(SERVICE_PREFIX) ? resource.slice(SERVICE_PREFIX.length) : null;
}

/**
 * Each service's label, by the name ECS gave the service in this raise.
 * The names are read from the dimensions of each service's own metrics.
 */
export function serviceLabelsOf(data: Pick<RunData, 'awsMetrics'>): ReadonlyMap<string, string> {
  return new Map(
    data.awsMetrics.flatMap(({ resource, series }) => {
      const label = serviceLabelOrNull(resource);
      const name = series.find((one) => one.dimensions.ServiceName !== undefined)?.dimensions
        .ServiceName;
      return label === null || name === undefined ? [] : [[name, label]];
    }),
  );
}

/**
 * What to call each target group's file of CloudWatch metrics, by the
 * file's resource name. A group is called by the label of the service
 * whose tasks it held, when the services' events say so and no other
 * group would share that label. Otherwise it keeps its own name.
 */
export function targetGroupLabelsOf(
  data: Pick<RunData, 'awsMetrics' | 'awsEvents'>,
): ReadonlyMap<string, string> {
  const services = serviceLabelsOf(data);
  const serviceOf = (group: string): string | null => {
    const registered = (data.awsEvents ?? []).find(
      (event) => event.source === 'ecs-service' && REGISTERED_IN.exec(event.summary)?.[1] === group,
    );
    return registered === undefined ? null : (services.get(registered.resource) ?? null);
  };
  const groups = data.awsMetrics
    .filter(({ resource }) => resource.startsWith(TARGET_GROUP_PREFIX))
    .map(({ resource }) => {
      const group = resource.slice(TARGET_GROUP_PREFIX.length);
      return { resource, group, service: serviceOf(group) };
    });
  const shared = (service: string | null): boolean =>
    groups.filter((other) => other.service === service).length > 1;
  return new Map(
    groups.map(({ resource, group, service }) => [
      resource,
      service === null || shared(service) ? group : service,
    ]),
  );
}
