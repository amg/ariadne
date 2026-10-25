import type {
  enqueueDriftGateJudgeArrival,
  judgeArrival,
} from '@queue/tasks/driftGateJudgeArrivalTask';
import { publish } from '@services/events';
import type { MemoryFeature } from '../../src/types/memory';

type ArrivalJudgment = Awaited<ReturnType<typeof judgeArrival>>;

type DriftGateJudgeArrivalParams = Parameters<typeof enqueueDriftGateJudgeArrival>[0];

/**
 * What a judged arrival means downstream: the verdict is announced, and a
 * fire that closed a segment owes that segment's capture while Memory is
 * on. The capture is queued before the pause is announced, so working
 * through the pause never starves the capture.
 */
export async function whenArrivalJudged({
  judgment,
  memory,
}: {
  judgment: ArrivalJudgment;
  memory: MemoryFeature;
}): Promise<void> {
  if (judgment.kind === 'gone') return;
  const { userId, threadId, messageId } = judgment;

  if (judgment.verdict !== 'fire') {
    publish({ kind: 'verdict-ok', userId, threadId, messageId, verdict: judgment.verdict });
    return;
  }

  if (memory.kind === 'on' && judgment.closedSegment) {
    await memory.enqueueMemoryCaptureSegment(judgment.closedSegment);
  }
  publish({
    kind: 'verdict-paused',
    userId,
    threadId,
    messageId,
    fireChannel: judgment.fireChannel,
  });
}

/** A judgment that stops trying on its own leaves its waiting chat telling itself to retry. */
export function whenJudgmentAbandoned(params: DriftGateJudgeArrivalParams) {
  publish({ kind: 'gate-failed', ...params });
}
