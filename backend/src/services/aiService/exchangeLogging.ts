/**
 * Telemetry only: how a chat request is written down as its Exchange
 * record. `recordingExchange` wraps a request and hands its result back
 * untouched; every other function reads what already happened and logs
 * it. Nothing here changes what the user sees or what the database holds.
 * Chat logic that needs a decision made belongs in the request's own code.
 */
import type { GateWaitCode } from '@ari/lib/api/schemas/chat/chat';
import { startExchangeLog } from '../../appRecords/exchangeLog';
import type { ExchangeOutcome, ExchangeRecord, ExchangeVerdict } from '../../appRecords/records';
import type { ChatOutcome } from '../../types/aiService';
import type { ExchangeLog } from '../../types/appRecords';
import type { Result } from '../../types/result';
import { type awaitArrivalGate, storedBeforeWait } from './arrivalGate';

type ArrivalGateOutcome = Awaited<ReturnType<typeof awaitArrivalGate>>;

/** What a chat request answers with: a pause, or a reply that settles as it streams. */
type RecordedSubmission =
  | { paused: true }
  | { assistantMessageId: string; outcome: Promise<Result<ChatOutcome>> };

/**
 * The endings the record tells apart from other refusals: the gate had no
 * verdict yet, or the client left before any reply started.
 */
const OUTCOMES_BY_CODE: Readonly<Record<GateWaitCode | 'client_gone', ExchangeOutcome>> = {
  gate_pending: 'gate-pending',
  gate_failed: 'gate-failed',
  client_gone: 'gone',
};

const isToldApart = (code: string): code is keyof typeof OUTCOMES_BY_CODE =>
  Object.hasOwn(OUTCOMES_BY_CODE, code);

/** How a request that ended before any reply started is written down. */
function refusalOutcomeOf(code: string): ExchangeOutcome {
  return isToldApart(code) ? OUTCOMES_BY_CODE[code] : 'refused';
}

/** How a reply that streamed ended. */
function endOfReply(settled: Result<ChatOutcome>): {
  outcome: ExchangeOutcome;
  errorCode: string | null;
} {
  if (settled.type === 'success') {
    const interrupted = settled.data.finishReason === 'interrupted';
    return { outcome: interrupted ? 'interrupted' : 'completed', errorCode: null };
  }
  const timedOut = settled.code === 'stream_timeout';
  return { outcome: timedOut ? 'timed-out' : 'failed', errorCode: settled.code };
}

/**
 * Writes down what the gate's outcome says of the arrival. A retry that
 * found the verdict already stored replays it, and the gate judged
 * nothing for it. A client gone before the gate answered leaves no verdict.
 */
export function logGateOutcome({
  exchangeLog,
  gate,
  trigger,
}: {
  exchangeLog: ExchangeLog;
  gate: ArrivalGateOutcome;
  trigger: ExchangeRecord['trigger'];
}): void {
  let verdict: ExchangeVerdict;
  switch (gate.kind) {
    case 'gone':
      return;
    case 'clear':
      verdict = gate.verdict?.verdict ?? 'off';
      break;
    case 'paused':
      verdict = 'fire';
      break;
    case 'failed':
      verdict = 'failed';
      break;
    case 'pending':
      verdict = 'pending';
      break;
    default: {
      const _check: never = gate;
      return;
    }
  }
  if (trigger === 'retry' && storedBeforeWait(gate)) {
    exchangeLog.logVerdictReplayed(verdict);
    return;
  }
  exchangeLog.logGateAnswered(verdict);
}

/**
 * Runs a chat request with its log, which writes the request's Exchange
 * record when it ends: at once for a refusal, a pause or a crash, and
 * when the reply settles for one that streams.
 */
export async function recordingExchange<Submission extends RecordedSubmission>({
  request,
  run,
}: {
  request: { userId: string; trigger: ExchangeRecord['trigger'] };
  run: (exchangeLog: ExchangeLog) => Promise<Result<Submission>>;
}): Promise<Result<Submission>> {
  const exchangeLog = startExchangeLog(request);
  let result: Result<Submission>;
  try {
    result = await run(exchangeLog);
  } catch (error) {
    exchangeLog.logEnded('failed', { errorCode: 'internal_error' });
    throw error;
  }
  if (result.type === 'error') {
    exchangeLog.logEnded(refusalOutcomeOf(result.code), { errorCode: result.code });
    return result;
  }
  const submission = result.data;
  if ('paused' in submission) {
    exchangeLog.logEnded('paused');
    return result;
  }
  void submission.outcome.then((settled) => {
    const { outcome, errorCode } = endOfReply(settled);
    exchangeLog.logEnded(outcome, { errorCode, assistantMessageId: submission.assistantMessageId });
  });
  return result;
}
