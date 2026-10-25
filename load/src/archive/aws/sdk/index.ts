import { ApplicationAutoScalingClient } from '@aws-sdk/client-application-auto-scaling';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { ECSClient } from '@aws-sdk/client-ecs';
import { PIClient } from '@aws-sdk/client-pi';
import { type Raise, metricTargetsOf } from '../raise.ts';
import type { RaiseSources } from '../sources.ts';
import { ecsSources } from './ecs.ts';
import { insightSources } from './insights.ts';
import { logSources } from './logs.ts';
import { metricSources } from './metrics.ts';
import { scalingSources } from './scaling.ts';

/** Reads a raise from AWS. */
export function awsSources(raise: Raise): RaiseSources {
  return {
    ...logSources(new CloudWatchLogsClient({})),
    ...metricSources(new CloudWatchClient({}), metricTargetsOf(raise)),
    ...ecsSources(new ECSClient({})),
    ...scalingSources(new ApplicationAutoScalingClient({})),
    ...insightSources(new PIClient({})),
  };
}
