import type { MessageExchangeStatus, MessageFinishReason } from '@db/types';
import { getMessageUsageByMessageId } from '@queries/messageUsage/getMessageUsageByMessageId';
import { insertMessageUsage } from '@queries/messageUsage/insertMessageUsage';
import { updateExchangeStatus } from '@queries/messages/updateExchangeStatus';
import { updateMessageContent } from '@queries/messages/updateMessageContent';
import type { FinishReason, LanguageModelUsage } from 'ai';
import { type Result, err, ok } from '../../types/result';
import { buildUsageRow, hasUsageReport } from './usageMap';

/**
 * One assistant exchange: accumulates streamed text, owns the latency
 * window and the inter-token idle watchdog, persists text +
 * `message_usage` on completion, and settles a single outcome promise
 * exactly once.
 *
 * Idle watchdog: arms on the first text delta (prefill is exempt) and
 * re-arms on every subsequent delta. When the deadline elapses it sets
 * `idleFired` and invokes `onIdleTimeout` (caller aborts the stream);
 * the completion paths read `idleFired` to distinguish `stream_timeout`
 * from user stop / client disconnect.
 */

export type ChatOutcome = {
  finishReason: MessageFinishReason;
  usagePersisted: boolean;
  latencyMs: number | null;
};

export type NaturalFinishEvent = {
  finishReason?: FinishReason;
  usage?: LanguageModelUsage;
  providerId?: string;
};

/** SDK → persisted finish state. 'error'/'other' are handled separately. */
const SDK_FINISH_REASON_MAP: Record<FinishReason, MessageFinishReason> = {
  stop: 'stop',
  length: 'length',
  'content-filter': 'content_filter',
  'tool-calls': 'tool_calls',
  // Handled before the map; these entries keep it total.
  error: 'stop',
  other: 'stop',
};

type ExchangeDeps = {
  assistantMessageId: string;
  model: string;
  /** Inter-token idle deadline. `<= 0` disables the watchdog. */
  idleTimeoutMs: number;
  /** Fired when the idle deadline elapses; caller aborts the stream. */
  onIdleTimeout: () => void;
};

export class ChatExchange {
  readonly outcome: Promise<Result<ChatOutcome>>;

  private assistantText = '';
  private assistantReasoning = '';
  private firstTokenAt: number | null = null;
  private lastChunkAt: number | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleFired = false;
  private settled = false;
  private readonly resolveOutcome: (value: Result<ChatOutcome>) => void;

  constructor(private readonly deps: ExchangeDeps) {
    let resolve: (value: Result<ChatOutcome>) => void = () => {};
    this.outcome = new Promise<Result<ChatOutcome>>((r) => {
      resolve = r;
    });
    // First resolution wins (onAbort/onEnd can race after an abort).
    this.resolveOutcome = (value) => {
      if (this.settled) return;
      this.settled = true;
      resolve(value);
    };
  }

  recordTextDelta(delta: string): void {
    this.assistantText += delta;
    this.recordActivity();
  }

  recordReasoningDelta(delta: string): void {
    this.assistantReasoning += delta;
    this.recordActivity();
  }

  private recordActivity(): void {
    const now = Date.now();
    if (this.firstTokenAt === null) this.firstTokenAt = now;
    this.lastChunkAt = now;
    this.armIdleTimer();
  }

  /** Normal stream end (onEnd): persist everything, report the outcome. */
  async completeNatural(event: NaturalFinishEvent): Promise<void> {
    this.clearIdleTimer();
    try {
      // Provider-side failure → partial text kept, no usage row, bubble error.
      if (event.finishReason === 'error' || event.finishReason === 'other') {
        await this.settleText('error');
        this.resolveOutcome(err('provider_error', 'The provider aborted the stream.'));
        return;
      }

      await this.settleText('completed');
      const finishReason =
        event.finishReason !== undefined ? SDK_FINISH_REASON_MAP[event.finishReason] : 'stop';
      const usagePersisted = await this.persistUsage(event, finishReason);
      this.resolveOutcome(ok({ finishReason, usagePersisted, latencyMs: this.latencyMs() }));
    } catch (error) {
      this.resolveOutcome(
        err('persist_failed', error instanceof Error ? error.message : undefined),
      );
    }
  }

  /** Aborted stream (onAbort): user stop, client disconnect or idle timeout. */
  async completeAbort(): Promise<void> {
    this.clearIdleTimer();
    // The idle guard fired the abort: the stream died on its own, nobody chose to stop it.
    const exchangeStatus: MessageExchangeStatus = this.idleFired ? 'error' : 'interrupted';
    await this.settleText(exchangeStatus).catch(() => {});
    if (this.idleFired) {
      this.resolveOutcome(err('stream_timeout', 'The stream went idle between tokens.'));
      return;
    }
    // Aborts carry no usage block → never a usage row.
    this.resolveOutcome(
      ok({ finishReason: 'interrupted', usagePersisted: false, latencyMs: this.latencyMs() }),
    );
  }

  /** Safety net (onError) so the outcome promise always settles. */
  async completeError(error: unknown): Promise<void> {
    this.clearIdleTimer();
    await this.settleText('error').catch(() => {});
    this.resolveOutcome(
      err(
        this.idleFired ? 'stream_timeout' : 'provider_error',
        error instanceof Error ? error.message : undefined,
      ),
    );
  }

  private armIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    if (this.deps.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleFired = true;
      this.idleTimer = null;
      this.deps.onIdleTimeout();
    }, this.deps.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private latencyMs(): number | null {
    return this.firstTokenAt === null
      ? null
      : (this.lastChunkAt ?? this.firstTokenAt) - this.firstTokenAt;
  }

  /**
   * Persists the final text and settles the row's exchange state in the
   * same write when text exists; a before-first-token abort has no
   * content to persist, so the exchange-state settle is the write.
   */
  private async settleText(exchangeStatus: MessageExchangeStatus): Promise<void> {
    // Reasoning is ephemeral (dropped at settlement), so only text drives the content write.
    if (this.assistantText !== '') {
      await updateMessageContent({
        messageId: this.deps.assistantMessageId,
        content: this.assistantText,
        exchangeStatus,
      });
      return;
    }
    await updateExchangeStatus({
      messageId: this.deps.assistantMessageId,
      exchangeStatus,
    });
  }

  private async persistUsage(
    event: NaturalFinishEvent,
    finishReason: MessageFinishReason,
  ): Promise<boolean> {
    if (!hasUsageReport(event.usage)) return false;
    const existing = await getMessageUsageByMessageId({
      messageId: this.deps.assistantMessageId,
    });
    if (existing) return false; // defensive: one row per message
    const usageArgs: Parameters<typeof buildUsageRow>[0] = {
      messageId: this.deps.assistantMessageId,
      model: this.deps.model,
      usage: event.usage,
      finishReason,
      latencyMs: this.latencyMs(),
    };
    if (this.assistantReasoning) usageArgs.reasoningContent = this.assistantReasoning;
    if (event.providerId !== undefined) usageArgs.providerId = event.providerId;
    await insertMessageUsage(await buildUsageRow(usageArgs));
    return true;
  }
}
