/**
 * Approximate on-demand prices in Sydney (ap-southeast-2), in USD. They
 * feed only the worst-case guard, which needs to be roughly right and
 * never low. Check them against the AWS pricing pages before the first run
 * and whenever a step moves to an instance class not listed here.
 */
export const PRICES = {
  fargate: {
    perVcpuHour: 0.05056,
    perGbHour: 0.00553,
  },
  /**
   * Fargate Spot, about 70% under On-Demand. The price moves with demand,
   * so it is rounded up to keep the guard from running low.
   */
  fargateSpot: {
    perVcpuHour: 0.0165,
    perGbHour: 0.0018,
  },
  /** Single-AZ PostgreSQL, per instance-hour. */
  rdsInstancePerHour: {
    'm7g.large': 0.22,
    'm7g.xlarge': 0.44,
    'r7g.large': 0.3,
    'r7g.xlarge': 0.6,
    'r7g.2xlarge': 1.2,
    'r7g.4xlarge': 2.4,
  } as Record<string, number>,
  rdsGp3PerGbMonth: 0.138,
  loadBalancer: {
    perHour: 0.0294,
    perLcuHour: 0.0084,
  },
  /** Per endpoint, per availability zone. */
  interfaceEndpointPerAzHour: 0.0132,
  redisServerless: {
    perGbHour: 0.101,
    perMillionEcpu: 0.0028,
  },
  /** The load network's way out: per gateway-hour, and per GB it carries in or out. */
  natGateway: {
    perHour: 0.059,
    perGb: 0.059,
  },
  publicAddressPerHour: 0.005,
  bastionPerHour: 0.0066,
  egressPerGb: 0.114,
  logsIngestPerGb: 0.7,
} as const;

export const HOURS_PER_MONTH = 730;
