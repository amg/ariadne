const AWS_METRICS_DIR = 'metrics/aws';

/**
 * The resources of a raise whose CloudWatch metrics a run keeps, each
 * under `metrics/aws/` in a file named after it.
 */
export const AWS_METRIC_RESOURCES = {
  appCluster: 'ecs-cluster-app',
  generatorCluster: 'ecs-cluster-generator',
  /** One of the app's services, by its label, such as `api`. */
  service: (label: string) => `ecs-service-${label}`,
  loadBalancer: 'load-balancer',
  /** One of the load balancer's target groups, by the name in its ARN. */
  targetGroup: (name: string) => `target-group-${name}`,
  database: 'database',
  cache: 'cache',
  fargateUsage: 'fargate-usage',
} as const;

/**
 * Where each kind of file sits in a run's folder, which lives under
 * load/.runs/ on the machine that ran or archived it.
 */
export const LAYOUT = {
  manifest: 'manifest.json',
  /** What a generator printed, kept only until the archive has sorted it into the folders below. */
  sourcesDir: '.sources',
  /** What the run's raise was made of, kept among the sources until the run is sealed. */
  raise: '.sources/raise.json',
  hostSamples: 'metrics/host.jsonl',
  events: 'events/events.jsonl',
  awsEvents: 'events/aws-events.jsonl',
  insights: 'database/performance-insights.jsonl',
  awsMetricsDir: AWS_METRICS_DIR,
  exchanges: 'app/exchanges.jsonl',
  jobs: 'app/jobs.jsonl',
  appState: 'app/state.jsonl',
  appRequests: 'app/requests.jsonl',
  /** Everything a rebuild writes. It can be deleted and written again at any time. */
  derivedDir: 'derived',
  summary: 'derived/summary.json',
  verdict: 'derived/verdict.md',
  metricsTable: 'derived/metrics.tsv',
  eventsLog: 'derived/events.log',
  report: 'derived/report.html',
  /** What one generator printed, by its slice and its attempt at running it, kept until the archive has sorted it. */
  generatorOutput: (generator: number, attempt: number) =>
    `.sources/generator-${generator}-attempt-${attempt}.out`,
  /** The request lines of one slice, whichever generator wrote them. */
  requests: (generator: number) => `requests/generator-${generator}.jsonl`,
  /** The state lines of one slice, whichever generator wrote them. */
  generatorState: (generator: number) => `metrics/generator-${generator}.state.jsonl`,
  /** The end report of one attempt at running a slice, kept as part of the slice's history. */
  generatorReport: (generator: number, attempt: number) =>
    `metrics/generator-${generator}-attempt-${attempt}.report.json`,
  /** What one attempt at running a slice printed besides its lines, kept to read by hand. */
  generatorLog: (generator: number, attempt: number) =>
    `logs/generator-${generator}-attempt-${attempt}.log`,
  processLog: (name: string) => `logs/${name}.log`,
  awsMetrics: (resource: string) => `${AWS_METRICS_DIR}/${resource}.jsonl`,
} as const;
