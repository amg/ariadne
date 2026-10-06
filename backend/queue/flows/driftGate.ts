import type {
  ArrivalJudgment,
  DriftGateJudgeArrivalParams,
} from '@queue/tasks/driftGateJudgeArrivalTask';
import { enqueueMemoryCaptureSegment } from '@queue/tasks/memoryCaptureSegmentTask';
import { publish } from '@services/events';
import { memoryFeature } from '@services/memory';

/**
 * What a judged arrival means downstream: the verdict is announced, and a
 * fire that closed a segment owes that segment's capture while Memory is
 * on. The capture is queued before the pause is announced, so working
 * through the pause never starves the capture.
 */
export async function whenArrivalJudged({
  params,
  judgment,
}: {
  params: DriftGateJudgeArrivalParams;
  judgment: ArrivalJudgment;
}): Promise<void> {
  if (judgment.kind === 'gone') return;
  const { userId, threadId, messageId } = judgment;

  if (judgment.verdict !== 'fire') {
    publish({ kind: 'verdict-ok', userId, threadId, messageId, verdict: judgment.verdict });
    return;
  }

  if (memoryFeature().kind === 'on' && judgment.closedSegment) {
    await enqueueMemoryCaptureSegment(judgment.closedSegment);
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
export function whenJudgmentAbandoned(params: DriftGateJudgeArrivalParams): void {
  publish({ kind: 'gate-failed', ...params });
}
