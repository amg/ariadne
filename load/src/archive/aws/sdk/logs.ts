import {
  type CloudWatchLogsClient,
  GetLogEventsCommand,
  paginateDescribeLogStreams,
} from '@aws-sdk/client-cloudwatch-logs';
import type { LogEvent, RaiseSources, TimeWindow } from '../sources.ts';
import { orUnavailable } from './failures.ts';

const GONE = ['ResourceNotFoundException'];

/** One logged message without the newlines CloudWatch may leave at its end. */
export const messageLine = (message: string) => message.replace(/\n+$/, '');

/** Whether a stream may hold events inside the window: all do but a stream that began after it ended. */
export function touchesWindow(stream: { firstEventTimestamp?: number }, window: TimeWindow) {
  // The last event time CloudWatch shows lags the stream, so it cannot rule one out.
  return (stream.firstEventTimestamp ?? 0) <= window.to.getTime();
}

export function logSources(
  client: CloudWatchLogsClient,
): Pick<RaiseSources, 'logStreams' | 'logMessages'> {
  return {
    async logStreams(group, window) {
      return orUnavailable(`the log group ${group}`, GONE, async () => {
        const streams: string[] = [];
        for await (const page of paginateDescribeLogStreams(
          { client },
          { logGroupName: group, orderBy: 'LogStreamName' },
        )) {
          const names = (page.logStreams ?? [])
            .filter((stream) => touchesWindow(stream, window))
            .flatMap((stream) => stream.logStreamName ?? []);
          streams.push(...names);
        }
        return streams;
      });
    },
    async *logMessages(group, stream, window: TimeWindow) {
      let token: string | undefined;
      for (;;) {
        const page = await orUnavailable(`the log group ${group}`, GONE, () =>
          client.send(
            new GetLogEventsCommand({
              logGroupName: group,
              logStreamName: stream,
              startTime: window.from.getTime(),
              endTime: window.to.getTime(),
              startFromHead: true,
              nextToken: token,
            }),
          ),
        );
        const messages = (page.events ?? []).flatMap((event): LogEvent[] =>
          event.message === undefined || event.timestamp === undefined
            ? []
            : [
                {
                  at: new Date(event.timestamp).toISOString(),
                  message: messageLine(event.message),
                },
              ],
        );
        if (messages.length > 0) yield messages;
        // The same token coming back means the stream has no more to give.
        if (page.nextForwardToken === undefined || page.nextForwardToken === token) return;
        token = page.nextForwardToken;
      }
    },
  };
}
