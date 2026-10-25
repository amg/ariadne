import type { FireChannel, GateVerdict } from '@ari/lib/api/schemas/common/driftGate';
import type { DbExecutor, MessageFinishReason, QueuedJob } from '@db/types';
import type { UIMessageChunk } from 'ai';
import type { Result } from './result';

/** The arrival a Drift gate judgment is about. */
export interface Arrival {
  userId: string;
  threadId: string;
  messageId: string;
}

/** The live gate's judgment of one arrival. */
export interface ArrivalVerdict {
  messageId: string;
  verdict: GateVerdict;
  fireChannel: FireChannel | null;
}

/** Queues the Drift gate's judgment of arrivals, and reports where one stands. */
export interface ArrivalJudging {
  /** Queues the arrival's judgment; given a transaction, it commits with the caller's writes. */
  enqueueDriftGateJudgeArrival(arrival: Arrival, trx?: DbExecutor): Promise<void>;
  /** The arrival's queued judgment; null when none is queued or it already finished. */
  findDriftGateJudgeArrivalJobOrNull(messageId: string): Promise<QueuedJob | null>;
}

/** How an exchange ended: why it finished, whether its usage was stored, and how long it took. */
export type ChatOutcome = {
  finishReason: MessageFinishReason;
  usagePersisted: boolean;
  latencyMs: number | null;
};

/** The reply stream of a started Exchange, and the promise of how it ended. */
export type ChatStreamHandle = {
  assistantMessageId: string;
  /** UI message stream (SSE-ready, consumable by `useChat`). */
  stream: ReadableStream<UIMessageChunk>;
  /** Settles once the stream has ended and persistence has completed. */
  outcome: Promise<Result<ChatOutcome>>;
  /** Aborts the provider stream from the outside (user stop). */
  abort: () => void;
  /**
   * The Drift gate's verdict on the user Message this Exchange answers,
   * for the advisory bubble signal. Absent when no verdict is stored for
   * that Message.
   */
  threadVerdict?: ArrivalVerdict;
};

/**
 * A submit whose arrival the gate fired on: the user Message is stored,
 * no Exchange started. It waits for the user to continue in this Thread
 * or hand it over to a fresh one.
 */
export type DriftPause = {
  paused: true;
  threadVerdict: ArrivalVerdict & { verdict: 'fire' };
};

/**
 * What the user asks of a retry. `continue` is the choice to keep a Paused
 * arrival in its Thread: its stored fire is replayed and the reply runs.
 * A plain `retry` of a Paused arrival only reports the pause again.
 */
export type RetryChoice = 'retry' | 'continue';
