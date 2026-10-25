import { isChat } from '../../records/index.ts';
import { maxOf, percentileOf } from '../numbers.ts';
import { gateWaitCounts, runMinutesOf } from '../runData/index.ts';
import { busiestGeneratorCpu } from '../table/index.ts';
import type { RunData } from '../types.ts';
import { fewestUsersInHold } from './hold.ts';
import { insideAnyOf } from './slices.ts';

/**
 * What the pass criteria judge a run by, from its raw lines. A chat the
 * server turned away or held for the user is not a failure, and nor is a
 * request sent with an expired access token and sent again once refreshed.
 * The requests of a slice inside a window it was down are left out, so
 * that losing a generator does not fail what its users could not do.
 */
export function runFiguresOf(data: RunData) {
  const requests = requestsOutsideDownWindows(data);
  const firstBytes = requests
    .filter((line) => isChat(line) && line.outcome === 'streamed')
    .map((line) => line.firstByteMs);
  const attempts = requests.filter(
    (line) =>
      line.kind === 'signin' || line.kind === 'refresh' || line.kind === 'thread' || isChat(line),
  );
  const failed = attempts.filter((line) => line.outcome === 'failed');
  const signIns = requests.filter((line) => line.kind === 'signin');
  const held = fewestUsersInHold(data);
  return {
    hostCpuPercentMax: maxOf(data.host?.map((sample) => sample.cpuPercent) ?? []),
    memoryUsedPercentMax: maxOf(data.host?.map((sample) => sample.memoryUsedPercent) ?? []),
    chatFirstByteP95Ms: percentileOf(firstBytes, 0.95),
    errorShare: attempts.length === 0 ? null : failed.length / attempts.length,
    pushStreamsLeastInHold: held.pushStreams?.count ?? null,
    chattersLeastInHold: held.chatters?.count ?? null,
    signInFailureShare:
      signIns.length === 0
        ? null
        : signIns.filter((line) => line.outcome === 'failed').length / signIns.length,
    gateWaitAtLimitShare: gateWaitShareOrNull(data),
    generatorCpuPercentMax: busiestGeneratorCpuOrNull(data),
  };
}

/** The request lines of every slice, but those it made inside a window it was down. */
function requestsOutsideDownWindows(data: RunData) {
  return data.slices.flatMap(({ slice, requests }) => {
    const down = insideAnyOf(slice.down);
    return (requests ?? []).filter((line) => !down(line.startedAt));
  });
}

function gateWaitShareOrNull(data: RunData) {
  const { atLimit, judged } = gateWaitCounts(data.exchanges ?? []);
  return judged === 0 ? null : atLimit / judged;
}

/** The busiest any generator got in any minute of the run, from the CloudWatch metrics the run kept. */
function busiestGeneratorCpuOrNull(data: RunData) {
  const [column] = busiestGeneratorCpu(data);
  if (column === undefined) return null;
  return maxOf(runMinutesOf(data).flatMap((minute) => column.at(minute) ?? []));
}
