import {
  type ApplicationAutoScalingClient,
  type ScalingActivity,
  paginateDescribeScalingActivities,
} from '@aws-sdk/client-application-auto-scaling';
import type { AwsEvent } from '../../../records/index.ts';
import type { RaiseSources } from '../sources.ts';
import { instantOrNull } from './failures.ts';

/** A scaling decision, as an event at the time it began. */
export function scalingEventOrNull(service: string, activity: ScalingActivity): AwsEvent | null {
  if (activity.StartTime === undefined) return null;
  return {
    at: activity.StartTime.toISOString(),
    source: 'scaling',
    resource: service,
    summary: activity.Description ?? '',
    detail: {
      cause: activity.Cause ?? null,
      status: activity.StatusCode ?? null,
      statusMessage: activity.StatusMessage ?? null,
      endedAt: instantOrNull(activity.EndTime),
    },
  };
}

/** A service with no scaling target has no activity, which is no error. */
export function scalingSources(
  client: ApplicationAutoScalingClient,
): Pick<RaiseSources, 'scalingActivity'> {
  return {
    async scalingActivity(cluster, services) {
      const events: AwsEvent[] = [];
      for (const service of services) {
        for await (const page of paginateDescribeScalingActivities(
          { client },
          {
            ServiceNamespace: 'ecs',
            ResourceId: `service/${cluster}/${service}`,
            IncludeNotScaledActivities: true,
          },
        )) {
          for (const activity of page.ScalingActivities ?? []) {
            const event = scalingEventOrNull(service, activity);
            if (event !== null) events.push(event);
          }
        }
      }
      return events;
    },
  };
}
