import type { DbExecutor } from '@db/types';
import { isLiveArrival } from '@queries/messages/isLiveArrival';
import { enqueueJob } from '@queries/queue/enqueueJob';
import { type QueuedJob, findJobByKeyOrNull } from '@queries/queue/findJobByKey';
import { findSegmentDriftLogByMessageId } from '@queries/segmentDriftLogs/findSegmentDriftLogByMessageId';
import { EMBEDDING_MODEL_ID } from '@services/aiService';
import type { SegmentToCapture } from '@services/memory';
import { runLiveGate } from '@services/threadAnalysis';
import type { FireChannel, GateVerdict } from '@services/threadAnalysis';
import { TaskFailure } from '../errors';

export const DRIFT_GATE_JUDGE_ARRIVAL = 'driftGateJudgeArrival';
const MAX_ATTEMPTS = 3;

/** The arrival to judge. */
export interface DriftGateJudgeArrivalParams {
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
): Promise<void> {
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
  return findJobByKeyOrNull({ task: DRIFT_GATE_JUDGE_ARRIVAL, key: messageId });
}

/**
 * What a judgment concluded. `gone` means the arrival is no longer live —
 * deleted or abandoned meanwhile — so the verdict answers nothing.
 */
export type ArrivalJudgment =
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
export async function judgeArrival(params: DriftGateJudgeArrivalParams): Promise<ArrivalJudgment> {
  if (!(await isLiveArrival(params))) return { kind: 'gone' };
  const { userId, threadId, messageId } = params;

  const gate = await runLiveGate({ threadId, upToMessageId: messageId });
  if (gate.type === 'error') {
    // Gone between the check and the pass: report it as such.
    if (gate.code === 'thread_not_found') return { kind: 'gone' };
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
