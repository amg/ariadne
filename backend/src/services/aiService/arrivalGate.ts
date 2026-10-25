import type { ThreadAnalysisMode } from '@ari/lib/api/schemas/threads/analysis';
import { env } from '@config/env';
import type { QueuedJob } from '@db/types';
import { findSegmentDriftLogByMessageId } from '@queries/segmentDriftLogs/findSegmentDriftLogByMessageId';
import { subscribe } from '@services/events';
import type { Arrival, ArrivalJudging, ArrivalVerdict } from '../../types/aiService';
import type { ServerEvent } from '../../types/events';
import { EMBEDDING_MODEL_ID } from './config';

/**
 * Where an arrival stands with the Drift gate once the wait is over:
 * judged clear (verdict null while the gate is switched off), fired on,
 * past help until the operator acts, still being judged when the wait ran
 * out, or unknown because the caller stopped waiting first. A verdict
 * that was stored before the wait began says so.
 */
type ArrivalGateOutcome =
  | { kind: 'clear'; verdict: ArrivalVerdict | null; storedBeforeWait?: boolean }
  | {
      kind: 'paused';
      verdict: ArrivalVerdict & { verdict: 'fire' };
      storedBeforeWait?: boolean;
    }
  | { kind: 'failed' }
  | { kind: 'pending' }
  | { kind: 'gone' };

/** Whether the outcome is a verdict that was already stored before the wait began. */
export function storedBeforeWait(gate: ArrivalGateOutcome) {
  return (gate.kind === 'clear' || gate.kind === 'paused') && gate.storedBeforeWait === true;
}

/**
 * Whether an arrival's queued judgment gave up for good: it failed fatally
 * and waits for the operator to re-queue it.
 */
export function judgmentFailed(job: QueuedJob | null) {
  return job?.state === 'dead' && job.errorClass === 'fatal';
}

type GateEvent = Extract<ServerEvent, { kind: 'verdict-ok' | 'verdict-paused' | 'gate-failed' }>;

function isGateEventFor(event: ServerEvent, messageId: string): event is GateEvent {
  return (
    (event.kind === 'verdict-ok' ||
      event.kind === 'verdict-paused' ||
      event.kind === 'gate-failed') &&
    event.messageId === messageId
  );
}

function outcomeOfEvent(event: GateEvent): ArrivalGateOutcome {
  switch (event.kind) {
    case 'verdict-ok':
      return {
        kind: 'clear',
        verdict:
          event.verdict === null
            ? null
            : { messageId: event.messageId, verdict: event.verdict, fireChannel: null },
      };
    case 'verdict-paused':
      return {
        kind: 'paused',
        verdict: { messageId: event.messageId, verdict: 'fire', fireChannel: event.fireChannel },
      };
    case 'gate-failed':
      return { kind: 'failed' };
  }
}

/**
 * Hears the outcome of one arrival's judgment. Open it, and wait until it
 * is `ready`, before the judgment can land, so nothing published in
 * between is missed.
 */
interface VerdictListener {
  /** Resolves once the verdict is published; never rejects. */
  ready: Promise<void>;
  /** The first outcome heard, or null once the time is up or the signal aborts. */
  next(ms: number, signal?: AbortSignal): Promise<ArrivalGateOutcome | null>;
  close(): void;
}

export function listenForVerdict(arrival: Arrival): VerdictListener {
  let heard: ArrivalGateOutcome | null = null;
  let wake: (() => void) | null = null;
  const subscription = subscribe(arrival.userId, (event) => {
    if (!isGateEventFor(event, arrival.messageId)) return;
    heard ??= outcomeOfEvent(event);
    wake?.();
  });

  return {
    ready: subscription.ready,
    next: (ms, signal) =>
      new Promise((resolve) => {
        if (heard !== null || signal?.aborted) {
          resolve(heard);
          return;
        }
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          wake = null;
          resolve(heard);
        };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener('abort', finish, { once: true });
        wake = finish;
      }),
    close: () => subscription.close(),
  };
}

/** The outcome an arrival's stored verdict gives; null while none is stored. */
export async function storedGateOutcomeOrNull(
  messageId: string,
): Promise<Extract<ArrivalGateOutcome, { kind: 'clear' | 'paused' }> | null> {
  const logged = await findSegmentDriftLogByMessageId({ messageId, modelId: EMBEDDING_MODEL_ID });
  if (!logged) return null;
  if (logged.verdict === 'fire') {
    return {
      kind: 'paused',
      verdict: { messageId, verdict: 'fire', fireChannel: logged.fireChannel },
    };
  }
  return {
    kind: 'clear',
    verdict: { messageId, verdict: logged.verdict, fireChannel: logged.fireChannel },
  };
}

type AwaitArrivalGateProps = {
  arrival: Arrival;
  /** Opened before the judgment could land. Closed here. */
  listener: VerdictListener;
  judging: ArrivalJudging;
  /** With the gate off, nothing is judged and every arrival is clear. */
  threadAnalysisMode: ThreadAnalysisMode;
  /** Aborts when nobody is waiting for the answer any more. */
  signal?: AbortSignal;
};

/**
 * The outcome from a stored verdict, or a judgment that failed fatally.
 * Null while the judgment is still owed.
 */
async function settledGateOutcomeOrNull(
  messageId: string,
  judging: ArrivalJudging,
): Promise<ArrivalGateOutcome | null> {
  const stored = await storedGateOutcomeOrNull(messageId);
  if (stored) return stored;
  const job = await judging.findDriftGateJudgeArrivalJobOrNull(messageId);
  return judgmentFailed(job) ? { kind: 'failed' } : null;
}

/**
 * Waits, up to the gate's wait limit, for the arrival's judgment. A stored
 * verdict answers at once. A judgment still queued or running is waited
 * on. One that gave up after recoverable failures, or was never queued, is
 * queued again and waited on; one that failed fatally answers `failed`
 * until the operator re-queues it. With the gate switched off nothing is
 * judged, and the arrival is clear.
 *
 * The stored state is checked again once the listener is sure to hear, and
 * once more when the wait runs out.
 *
 * A caller that stops waiting before the gate answers is `gone`.
 */
export async function awaitArrivalGate({
  arrival,
  listener,
  judging,
  threadAnalysisMode,
  signal,
}: AwaitArrivalGateProps): Promise<ArrivalGateOutcome> {
  try {
    if (threadAnalysisMode === 'off') return { kind: 'clear', verdict: null };
    await listener.ready;
    const stored = await storedGateOutcomeOrNull(arrival.messageId);
    if (stored) return { ...stored, storedBeforeWait: true };

    const job = await judging.findDriftGateJudgeArrivalJobOrNull(arrival.messageId);
    if (judgmentFailed(job)) return { kind: 'failed' };
    if (job === null || job.state === 'dead') await judging.enqueueDriftGateJudgeArrival(arrival);

    const heard = await listener.next(env.GATE_WAIT_MS, signal);
    if (heard) return heard;
    if (signal?.aborted) return { kind: 'gone' };
    return (await settledGateOutcomeOrNull(arrival.messageId, judging)) ?? { kind: 'pending' };
  } finally {
    listener.close();
  }
}
