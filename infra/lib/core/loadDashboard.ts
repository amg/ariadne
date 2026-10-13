import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { PROJECT } from '../../config/names.ts';

const MINUTE = 60;
const WIDTH = 8;
const HEIGHT = 6;

const BALANCER = 'AWS/ApplicationELB,LoadBalancer';
const DATABASE = 'AWS/RDS,DBInstanceIdentifier';
const CACHE = 'AWS/ElastiCache,clusterId';
const SERVICE = 'AWS/ECS,ClusterName,ServiceName';

/**
 * The app's services: the word each one's generated ECS name carries, and
 * the label and colour it keeps on every graph.
 */
const SERVICES = [
  { label: 'api', nameWord: 'Api', color: cloudwatch.Color.BLUE },
  { label: 'worker', nameWord: 'Worker', color: cloudwatch.Color.ORANGE },
  { label: 'auth', nameWord: 'Auth', color: cloudwatch.Color.GREEN },
  { label: 'web', nameWord: 'Web', color: cloudwatch.Color.PURPLE },
  { label: 'mock', nameWord: 'Mock', color: cloudwatch.Color.GREY },
];

/**
 * One page for reading a load run: traffic at the load balancer, each
 * service's CPU and memory, the database and the cache, on one time axis.
 *
 * It lives in core so it outlasts every raise. Every raise creates its
 * database, cluster and load balancer under new names, so each line finds
 * its metrics by pattern and combines whatever matched into one line;
 * only one raise runs at a time, so combining loses nothing. CloudWatch
 * keeps a torn-down raise's one-minute data for 15 days, so past runs stay
 * readable here too.
 */
export class LoadDashboard extends Construct {
  readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${PROJECT}-load`,
      start: '-PT3H',
      widgets: [
        [
          new cloudwatch.TextWidget({
            markdown: [
              `### ${PROJECT} load runs`,
              'Shows whichever raise ran in the time range, up or torn down. Sign-in, reply and pause numbers come from the generators, in `infra/.runs/<run>/summary.txt`.',
            ].join('\n\n'),
            width: 24,
            height: 2,
          }),
        ],
        ...row('Traffic at the load balancer', [
          graph('Requests per minute', [count(BALANCER, 'RequestCount', 'requests')]),
          graph(
            'Response time (seconds)',
            ['p50', 'p95', 'p99'].map((percentile) =>
              level(BALANCER, 'TargetResponseTime', percentile, percentile),
            ),
          ),
          graph('Errors per minute', [
            count(BALANCER, 'HTTPCode_Target_5XX_Count', 'app 5xx'),
            count(BALANCER, 'HTTPCode_ELB_5XX_Count', 'balancer 5xx'),
            count(BALANCER, 'HTTPCode_Target_4XX_Count', 'app 4xx'),
          ]),
        ]),
        ...row('Services', [
          graph('CPU %, average task', perService('CPUUtilization', 'Average'), { leftMax: 100 }),
          graph('CPU %, busiest task', perService('CPUUtilization', 'Maximum'), { leftMax: 100 }),
          graph('Memory %, average task', perService('MemoryUtilization', 'Average'), {
            leftMax: 100,
          }),
        ]),
        ...row('Database', [
          graph('CPU %', [level(DATABASE, 'CPUUtilization', 'Maximum', 'CPU')], { leftMax: 100 }),
          graph(
            'Sessions busy at once (above the vCPU count means queueing)',
            [
              level(DATABASE, 'DBLoadCPU', 'Average', 'on CPU'),
              level(DATABASE, 'DBLoadNonCPU', 'Average', 'waiting'),
            ],
            { stacked: true },
          ),
          graph('Connections', [level(DATABASE, 'DatabaseConnections', 'Maximum', 'connections')]),
        ]),
        ...row('Disk and cache', [
          graph('Database IOPS', [
            level(DATABASE, 'ReadIOPS', 'Average', 'read'),
            level(DATABASE, 'WriteIOPS', 'Average', 'write'),
          ]),
          graph('Database disk latency (seconds)', [
            level(DATABASE, 'ReadLatency', 'Average', 'read'),
            level(DATABASE, 'WriteLatency', 'Average', 'write'),
          ]),
          graph('Cache commands per minute', [
            count(CACHE, 'GetTypeCmds', 'reads'),
            count(CACHE, 'SetTypeCmds', 'writes'),
          ]),
        ]),
      ],
    });
  }
}

/** A section heading on its own row, then its graphs side by side. */
function row(title: string, graphs: cloudwatch.IWidget[]): cloudwatch.IWidget[][] {
  return [[new cloudwatch.TextWidget({ markdown: `#### ${title}`, width: 24, height: 1 })], graphs];
}

type GraphOptions = {
  /** Top of the left axis: 100 for percentages. */
  leftMax?: number;
  stacked?: boolean;
};

function graph(
  title: string,
  lines: cloudwatch.IMetric[],
  { leftMax, stacked = false }: GraphOptions = {},
): cloudwatch.GraphWidget {
  return new cloudwatch.GraphWidget({
    title,
    left: lines,
    stacked,
    width: WIDTH,
    height: HEIGHT,
    leftYAxis: { min: 0, ...(leftMax === undefined ? {} : { max: leftMax }) },
  });
}

/** A count summed over every matching resource. */
function count(dimensions: string, metric: string, label: string): cloudwatch.MathExpression {
  return combined({
    combine: 'SUM',
    search: `{${dimensions}} MetricName="${metric}"`,
    statistic: 'Sum',
    label,
  });
}

/** A level or percentile, the highest of every matching resource. */
function level(
  dimensions: string,
  metric: string,
  statistic: string,
  label: string,
): cloudwatch.MathExpression {
  return combined({
    combine: 'MAX',
    search: `{${dimensions}} MetricName="${metric}"`,
    statistic,
    label,
  });
}

/** One line per service, matched by the word in its generated name. */
function perService(metric: string, statistic: string): cloudwatch.MathExpression[] {
  return SERVICES.map((service) =>
    combined({
      combine: 'MAX',
      search: `{${SERVICE}} MetricName="${metric}" ServiceName=${service.nameWord}`,
      statistic,
      label: service.label,
      color: service.color,
    }),
  );
}

/** Every series a search finds, combined into one labelled line. */
function combined(line: {
  combine: 'SUM' | 'MAX';
  search: string;
  statistic: string;
  label: string;
  color?: string;
}): cloudwatch.MathExpression {
  return new cloudwatch.MathExpression({
    expression: `${line.combine}(SEARCH('${line.search}', '${line.statistic}', ${MINUTE}))`,
    usingMetrics: {},
    label: line.label,
    period: Duration.seconds(MINUTE),
    ...(line.color === undefined ? {} : { color: line.color }),
  });
}
