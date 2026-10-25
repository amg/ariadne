import { SIGNALS, namespacesOf } from '@ari/lib/metrics/catalogue';
import { z } from 'zod';
import { AWS_METRIC_RESOURCES, type Finding, LAYOUT, instant } from '../../records/index.ts';
import type { ExpectedSource } from '../selfChecks.ts';

const stackSchema = z.object({ name: z.string(), id: z.string() });

/**
 * What a raise was made of, written down while it stood so that a run can
 * be archived after its stacks are gone: the names of its clusters, services
 * and log groups, its load balancer, its database and its cache.
 */
export const raiseSchema = z.object({
  account: z.string(),
  region: z.string(),
  /** When the app stack was created. */
  startedAt: instant,
  stacks: z.object({ app: stackSchema, load: stackSchema }),
  clusters: z.object({ app: z.string(), load: z.string() }),
  services: z.array(z.object({ label: z.string(), cluster: z.string(), name: z.string() })),
  logGroups: z.array(
    z.object({ label: z.string(), name: z.string(), stack: z.enum(['app', 'load']) }),
  ),
  loadBalancer: z.object({
    /** As CloudWatch names it in a dimension: `app/<name>/<id>`. */
    dimension: z.string(),
  }),
  targetGroups: z.array(z.string()),
  database: z.object({ identifier: z.string(), resourceId: z.string().nullable() }),
  cache: z.object({ name: z.string() }),
});
export type Raise = z.infer<typeof raiseSchema>;

/**
 * The app's log groups a run keeps: the services whose logs say what broke
 * in an incident. The others, such as the web server's and the network's
 * flow logs, stay in CloudWatch for a month.
 */
const KEPT_APP_LOG_GROUPS: readonly string[] = ['api', 'worker', 'auth'];

/** The app's log groups a run of this raise keeps. */
export function keptAppLogGroupsOf(raise: Raise) {
  return raise.logGroups.filter(
    (group) => group.stack === 'app' && KEPT_APP_LOG_GROUPS.includes(group.label),
  );
}

/** The label under which a load generator's log group, and every other thing of the load stack, goes. */
export const GENERATOR_LABEL = 'generator';

/** A group of CloudWatch metrics that belong to one resource of the raise. */
export type MetricTarget = {
  /** Names the file the resource's metrics are kept in. */
  label: string;
  namespaces: readonly string[];
  /**
   * The dimensions a metric must carry, name and value. The name `*` stands
   * for any dimension, so that a value alone can pick the metrics out.
   * A metric that several targets match belongs to the one that names the
   * most dimensions.
   */
  dimensions: Readonly<Record<string, string>>;
};

/** The metrics of every resource of the raise that CloudWatch holds some for. */
export function metricTargetsOf(raise: Raise) {
  const clusterTarget = (cluster: string, label: string): MetricTarget => ({
    label,
    namespaces: namespacesOf({ ...SIGNALS.service, ...SIGNALS.generators }),
    dimensions: { ClusterName: cluster },
  });
  return [
    clusterTarget(raise.clusters.app, AWS_METRIC_RESOURCES.appCluster),
    clusterTarget(raise.clusters.load, AWS_METRIC_RESOURCES.generatorCluster),
    ...raise.services.map(
      (service): MetricTarget => ({
        label: AWS_METRIC_RESOURCES.service(service.label),
        namespaces: namespacesOf(SIGNALS.service),
        dimensions: { ClusterName: service.cluster, ServiceName: service.name },
      }),
    ),
    {
      label: AWS_METRIC_RESOURCES.loadBalancer,
      namespaces: namespacesOf(SIGNALS.loadBalancer),
      dimensions: { LoadBalancer: raise.loadBalancer.dimension },
    },
    ...raise.targetGroups.map(
      (group): MetricTarget => ({
        label: AWS_METRIC_RESOURCES.targetGroup(group.split('/')[1] ?? group),
        namespaces: namespacesOf(SIGNALS.targetGroup),
        dimensions: { LoadBalancer: raise.loadBalancer.dimension, TargetGroup: group },
      }),
    ),
    {
      label: AWS_METRIC_RESOURCES.database,
      namespaces: namespacesOf(SIGNALS.database),
      dimensions: { DBInstanceIdentifier: raise.database.identifier },
    },
    {
      label: AWS_METRIC_RESOURCES.cache,
      namespaces: namespacesOf(SIGNALS.cache),
      dimensions: { '*': raise.cache.name },
    },
    {
      label: AWS_METRIC_RESOURCES.fargateUsage,
      namespaces: namespacesOf(SIGNALS.fargateUsage),
      dimensions: { Service: 'Fargate' },
    },
  ];
}

/**
 * The logs and metrics a raise's run must leave: the log group of each
 * service whose logs are kept, every service's CPU and memory, the
 * database, the cache and the load balancer.
 */
export function expectedSourcesOf(raise: Raise) {
  const metrics = (service: string, label: string): ExpectedSource => ({
    service,
    kind: 'metrics',
    path: LAYOUT.awsMetrics(label),
  });
  return [
    ...keptAppLogGroupsOf(raise).map(
      (group): ExpectedSource => ({
        service: group.label,
        kind: 'logs',
        path: LAYOUT.processLog(group.label),
      }),
    ),
    ...raise.services.map((service) =>
      metrics(service.label, AWS_METRIC_RESOURCES.service(service.label)),
    ),
    metrics('postgres', AWS_METRIC_RESOURCES.database),
    metrics('cache', AWS_METRIC_RESOURCES.cache),
    metrics('load balancer', AWS_METRIC_RESOURCES.loadBalancer),
  ];
}

/** The finding for a source of the raise that cannot be collected because the thing it comes from is gone. */
export function unavailable(source: string, reason: string): Finding {
  return { check: 'sources-collected', detail: `${source}: ${reason}`, path: null };
}
