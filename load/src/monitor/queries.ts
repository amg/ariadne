import { SIGNALS, type Signal, searchOf } from '@ari/lib/metrics/catalogue';

/** The seconds each point of a series covers. */
const PERIOD_SECONDS = 60;

/** What a series measures, by the first word of its label. */
const MEASURES = [
  'users',
  'chat_p95',
  'running',
  'desired',
  'cpu',
  'db_cpu',
  'db_load',
  'requests',
  'alb_p95',
] as const;
export type Measure = (typeof MEASURES)[number];

/** The resources of one stack that `monitor` narrows its figures to; a figure whose resource is missing is not narrowed. */
export type MonitorScope = {
  cluster?: string;
  /** As CloudWatch names it: `app/<name>/<id>`. */
  loadBalancer?: string;
  database?: string;
};

type Query = {
  id: string;
  measure: Measure;
  signal: Signal;
  byService: boolean;
  /** The dimension that tells one stack's series from another's, and which resource of the scope it holds. */
  narrowedBy: { dimension: string; resource: keyof MonitorScope } | null;
};

const BY_CLUSTER = { dimension: 'ClusterName', resource: 'cluster' } as const;
const BY_DATABASE = { dimension: 'DBInstanceIdentifier', resource: 'database' } as const;
const BY_LOAD_BALANCER = { dimension: 'LoadBalancer', resource: 'loadBalancer' } as const;

const QUERIES: readonly Query[] = [
  {
    id: 'users',
    measure: 'users',
    signal: SIGNALS.load.usersSignedIn,
    byService: false,
    narrowedBy: null,
  },
  {
    id: 'chat',
    measure: 'chat_p95',
    signal: SIGNALS.load.chatFirstByteP95,
    byService: false,
    narrowedBy: null,
  },
  {
    id: 'running',
    measure: 'running',
    signal: SIGNALS.service.runningTasks,
    byService: true,
    narrowedBy: BY_CLUSTER,
  },
  {
    id: 'desired',
    measure: 'desired',
    signal: SIGNALS.service.desiredTasks,
    byService: true,
    narrowedBy: BY_CLUSTER,
  },
  {
    id: 'cpu',
    measure: 'cpu',
    signal: SIGNALS.service.cpuAverage,
    byService: true,
    narrowedBy: BY_CLUSTER,
  },
  {
    id: 'dbcpu',
    measure: 'db_cpu',
    signal: SIGNALS.database.cpu,
    byService: false,
    narrowedBy: BY_DATABASE,
  },
  {
    id: 'dbload',
    measure: 'db_load',
    signal: SIGNALS.database.sessionsBusy,
    byService: false,
    narrowedBy: BY_DATABASE,
  },
  {
    id: 'req',
    measure: 'requests',
    signal: SIGNALS.loadBalancer.requests,
    byService: false,
    narrowedBy: BY_LOAD_BALANCER,
  },
  {
    id: 'albp95',
    measure: 'alb_p95',
    signal: SIGNALS.loadBalancer.responseTimeP95,
    byService: false,
    narrowedBy: BY_LOAD_BALANCER,
  },
];

/** The measures whose series are split by service. */
const PER_SERVICE: ReadonlySet<Measure> = new Set(
  QUERIES.filter((query) => query.byService).map((query) => query.measure),
);

/** A query's search, narrowed to the scope's resource when the scope has it. */
function narrowedSearchOf(query: Query, scope: MonitorScope) {
  if (query.narrowedBy === null) return searchOf(query.signal);
  const value = scope[query.narrowedBy.resource];
  if (value === undefined) return searchOf(query.signal);
  return searchOf(query.signal, { exact: { [query.narrowedBy.dimension]: value } });
}

/** How the series of a measure that CloudWatch holds for one minute become one figure. */
export function minuteCombineOf(measure: Measure) {
  const query = QUERIES.find((candidate) => candidate.measure === measure);
  if (query === undefined) throw new Error(`No query measures ${measure}`);
  return query.signal.minute;
}

/**
 * What `monitor` asks CloudWatch for, narrowed to the stack in `scope`. Every
 * series' label starts with its measure, and a per-service series' label
 * follows that with the service's name.
 */
export function monitorQueries(scope: MonitorScope): {
  Id: string;
  Expression: string;
  Label: string;
  ReturnData: true;
}[] {
  return QUERIES.map((query) => ({
    Id: query.id,
    Expression: `SEARCH('${narrowedSearchOf(query, scope)}', '${query.signal.statistic}', ${PERIOD_SECONDS})`,
    Label: query.byService ? `${query.measure} \${PROP('Dim.ServiceName')}` : query.measure,
    ReturnData: true,
  }));
}

/** What a series measures and, for a per-service one, which service, from its label; null for a label this part did not ask for. */
export function measureOrNull(label: string) {
  const separator = label.indexOf(' ');
  const word = separator === -1 ? label : label.slice(0, separator);
  const measure = MEASURES.find((known) => known === word);
  if (measure === undefined) return null;
  // When one search finds several series, CloudWatch follows a fixed label
  // with each series' own name, which is not a service.
  if (separator === -1 || !PER_SERVICE.has(measure)) return { measure, service: null };
  return { measure, service: serviceWordOf(label.slice(separator + 1)) };
}

/** The word a service's generated name carries between `Services` and `Service`, in lower case; the whole name when it carries none. */
export function serviceWordOf(name: string) {
  const word = /Services([A-Za-z]+)Service/.exec(name)?.[1];
  return (word ?? name).toLowerCase();
}
