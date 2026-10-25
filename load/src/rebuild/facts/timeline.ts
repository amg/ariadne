import { formattedUserRange } from '../../records/index.ts';
import { serviceLabelsOf } from '../table/index.ts';
import type { RunData } from '../types.ts';
import { describeAwsEvent, describeEvent, inTimeOrder } from './descriptions.ts';
import { secondsBetween } from './gaps.ts';

/**
 * Everything that happened in the run on one timeline, oldest first: the
 * run's own events, when each slice began holding its users and when it
 * went down, what AWS recorded of the raise, and when the run was sealed.
 */
export function timelineOf(data: RunData) {
  const { manifest } = data;
  const serviceLabels = serviceLabelsOf(data);
  return inTimeOrder([
    ...(data.events ?? []).map((event) => ({ at: event.at, text: describeEvent(event) })),
    ...manifest.slices.flatMap((slice) => {
      const users = formattedUserRange(slice);
      return [
        ...(slice.hold === null
          ? []
          : [{ at: slice.hold.from, text: `generator ${slice.generator} holding users ${users}` }]),
        ...slice.down.map(({ from, to, reason }) => ({
          at: from,
          text: `users ${users} down for ${secondsBetween(from, to)} s: ${reason}`,
        })),
      ];
    }),
    ...(data.awsEvents ?? []).map((event) => ({
      at: event.at,
      text: describeAwsEvent(event, serviceLabels),
    })),
    { at: manifest.seal.sealedAt, text: `run sealed as ${manifest.seal.status}` },
  ]);
}
