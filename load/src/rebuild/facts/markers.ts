import { serviceLabelsOf } from '../table/index.ts';
import type { RunData } from '../types.ts';
import { describeAwsEvent, describeEvent, inTimeOrder } from './descriptions.ts';

/**
 * The moments every chart marks, oldest first: each generator's launch and
 * stop, each scaling decision AWS made, and each deployment of a service.
 */
export function markersOf(data: RunData) {
  const serviceLabels = serviceLabelsOf(data);
  return inTimeOrder([
    ...(data.events ?? []).flatMap((event) =>
      event.kind === 'generator-launched' || event.kind === 'generator-stopped'
        ? [{ at: event.at, what: describeEvent(event) }]
        : [],
    ),
    ...(data.awsEvents ?? []).flatMap((event) =>
      event.source === 'scaling' || event.source === 'deployment'
        ? [{ at: event.at, what: describeAwsEvent(event, serviceLabels) }]
        : [],
    ),
  ]);
}
