import type { FireChannel, GateVerdict } from '@ari/lib/api/schemas/common/driftGate';
import type { ThreadAnalysisMode } from '@ari/lib/api/schemas/threads/analysis';
import type { DbExecutor, QueuedJob } from '@db/types';
import { isLiveArrival } from '@queries/messages/isLiveArrival';
import { enqueueJob } from '@queries/queue/enqueueJob';
import { findJobByKey } from '@queries/queue/findJobByKey';
import { findSegmentDriftLogByMessageId } from '@queries/segmentDriftLogs/findSegmentDriftLogByMessageId';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import { runLiveGate } from '@services/threadAnalysis';
import type { SegmentToCapture } from '../../src/types/memory';
import { MAX_ATTEMPTS, TaskFailure } from '../errors';

export const DRIFT_GATE_JUDGE_ARRIVAL = 'driftGateJudgeArrival';

/** The arrival to judge. */
interface DriftGateJudgeArrivalParams {
  userId: string;
  threadId: string;
  messageId: string;
}

declare global {
  namespace GraphileWorker {
    interface Tasks {
      driftGateJudgeArrival: DriftGateJudgeArrivalParams;
    }
  }
}

/** Queues the arrival's judgment; a judgment still waiting for the same arrival absorbs it. */
export function enqueueDriftGateJudgeArrival(
  params: DriftGateJudgeArrivalParams,
  trx?: DbExecutor,
) {
  return enqueueJob(
    {
      task: DRIFT_GATE_JUDGE_ARRIVAL,
      payload: { ...params },
      key: params.messageId,
      maxAttempts: MAX_ATTEMPTS,
    },
    trx,
  );
}

/** The arrival's judgment in the queue; null when none is queued or it finished. */
export function findDriftGateJudgeArrivalJobOrNull(messageId: string): Promise<QueuedJob | null> {
  return findJobByKey({ task: DRIFT_GATE_JUDGE_ARRIVAL, key: messageId });
}

/**
 * What a judgment concluded. `gone` means the arrival is no longer live —
 * deleted or abandoned meanwhile — so the verdict answers nothing.
 */
type ArrivalJudgment =
  | { kind: 'gone' }
  | {
      kind: 'judged';
      userId: string;
      threadId: string;
      messageId: string;
      verdict: GateVerdict | null;
      /** Which drift the fire caught; null while the gate is switched off. */
      fireChannel: FireChannel | null;
      /** The segment a fire closed, owed a capture; null when none was logged. */
      closedSegment: SegmentToCapture | null;
    };

/**
 * Judges one arrival with the Drift gate and reports what it concluded,
 * nothing more. The gate replays what it already stored, so judging the
 * same arrival again concludes the same. An arrival that was deleted or
 * abandoned in the meantime is reported gone, never an error.
 */
export async function judgeArrival({
  arrival,
  threadAnalysisMode,
}: {
  arrival: DriftGateJudgeArrivalParams;
  threadAnalysisMode: ThreadAnalysisMode;
}): Promise<ArrivalJudgment> {
  if (!(await isLiveArrival(arrival))) return { kind: 'gone' };
  const { userId, threadId, messageId } = arrival;

  const gate = await runLiveGate({ threadId, upToMessageId: messageId, mode: threadAnalysisMode });
  if (gate.type === 'error') {
    // Abandoned after the check, before or during the pass: report it as such.
    if (gate.code === 'arrival_not_live') return { kind: 'gone' };
    throw new TaskFailure(gate.code, gate.message);
  }

  if (gate.data.verdict !== 'fire') {
    return {
      kind: 'judged',
      userId,
      threadId,
      messageId,
      verdict: gate.data.verdict,
      fireChannel: null,
      closedSegment: null,
    };
  }

  let closedSegment: SegmentToCapture | null = null;
  const logged = await findSegmentDriftLogByMessageId({ messageId, modelId: EMBEDDING_MODEL_ID });
  if (logged) closedSegment = { userId, threadId, segmentId: logged.segmentId };

  return {
    kind: 'judged',
    userId,
    threadId,
    messageId,
    verdict: 'fire',
    fireChannel: gate.data.fireChannel,
    closedSegment,
  };
}
