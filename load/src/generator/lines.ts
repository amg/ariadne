import { DIMENSIONS, NAMESPACES, SIGNALS } from '@ari/lib/metrics/catalogue';
import { type MetricGroup, measureOf, metricFields } from '@ari/lib/metrics/emf';
import { type RequestLine, type StateLine, isChat } from '../records/index.ts';

function requestGroups(line: RequestLine): MetricGroup[] {
  return [
    {
      dimensions: { [DIMENSIONS.kind]: line.kind },
      measures: [
        measureOf(SIGNALS.load.requests, 1),
        measureOf(SIGNALS.load.failures, line.outcome === 'failed' ? 1 : 0),
      ],
    },
    {
      measures:
        isChat(line) && line.outcome === 'streamed'
          ? [measureOf(SIGNALS.load.chatFirstByteP95, line.firstByteMs)]
          : [],
    },
  ];
}

function stateGroups(line: StateLine): MetricGroup[] {
  return [
    {
      dimensions: { [DIMENSIONS.generator]: String(line.generator) },
      measures: [
        measureOf(SIGNALS.load.usersSignedIn, line.usersSignedIn),
        measureOf(SIGNALS.load.pushStreamsOpen, line.pushStreamsOpen),
        measureOf(SIGNALS.load.chattersActive, line.chattersActive),
      ],
    },
  ];
}

/**
 * The line a generator prints for a request. By default the record follows
 * a `REQUEST` marker. Where metrics are published the line is one JSON
 * object, the record under `request` and the request's figures beside it as
 * metric fields, counted at the moment the line is written `at`.
 */
export function requestLineText({
  line,
  publishMetrics,
  at = new Date(),
}: {
  line: RequestLine;
  publishMetrics: boolean;
  at?: Date;
}) {
  if (!publishMetrics) return `REQUEST ${JSON.stringify(line)}`;
  const fields = metricFields(NAMESPACES.load, at, requestGroups(line));
  return JSON.stringify({ request: line, ...fields });
}

/** The line a generator prints for its running state, in the same two forms. */
export function stateLineText(line: StateLine, publishMetrics: boolean) {
  if (!publishMetrics) return `STATE ${JSON.stringify(line)}`;
  const fields = metricFields(NAMESPACES.load, new Date(line.at), stateGroups(line));
  return JSON.stringify({ state: line, ...fields });
}
