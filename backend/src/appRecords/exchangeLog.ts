import type { ExchangeLog } from '../types/appRecords';
import { type ExchangeRecord, type ExchangeVerdict, elapsedMsSince, logAppRecord } from './records';

/** Starts the log of a chat request that has just arrived. */
export function startExchangeLog(input: {
  userId: string;
  trigger: ExchangeRecord['trigger'];
}): ExchangeLog {
  const arrivedAt = new Date().toISOString();
  const began = performance.now();
  const elapsedMs = () => elapsedMsSince(began);
  let verdict: { answer: ExchangeVerdict; afterMs: number; replayed: boolean } | null = null;
  let firstTokenAfterMs: number | null = null;
  let written = false;

  return {
    logGateAnswered(answer) {
      verdict ??= { answer, afterMs: elapsedMs(), replayed: false };
    },
    logVerdictReplayed(answer) {
      verdict ??= { answer, afterMs: elapsedMs(), replayed: true };
    },
    logFirstToken() {
      firstTokenAfterMs ??= elapsedMs();
    },
    logEnded(outcome, details = {}) {
      if (written) return;
      written = true;
      logAppRecord({
        kind: 'exchange',
        userId: input.userId,
        trigger: input.trigger,
        arrivedAt,
        verdict: verdict?.answer ?? null,
        verdictReplayed: verdict?.replayed ?? false,
        verdictAfterMs: verdict?.afterMs ?? null,
        firstTokenAfterMs,
        endedAfterMs: elapsedMs(),
        outcome,
        errorCode: details.errorCode ?? null,
        assistantMessageId: details.assistantMessageId ?? null,
      });
    },
  };
}
