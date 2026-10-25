import { useAppRecordCapture } from '@test/appRecords';
import { describe, expect, it } from 'vitest';
import type { ChatOutcome } from '../../types/aiService';
import type { ExchangeLog } from '../../types/appRecords';
import { type Result, err, ok } from '../../types/result';
import { recordingExchange } from './exchangeLogging';

const capture = useAppRecordCapture();
const request = { userId: 'user-1', trigger: 'submit' } as const;

type Submission =
  | { paused: true }
  | { assistantMessageId: string; outcome: Promise<Result<ChatOutcome>> };

const reply = (settled: Result<ChatOutcome>): Submission => ({
  assistantMessageId: 'reply-1',
  outcome: Promise.resolve(settled),
});
const stopped = (finishReason: ChatOutcome['finishReason']) =>
  ok<ChatOutcome>({ finishReason, usagePersisted: true, latencyMs: 5 });

async function recorded(run: (exchangeLog: ExchangeLog) => Promise<Result<Submission>>) {
  await recordingExchange({ request, run });
  await Promise.resolve();
  return capture.written('exchange');
}

describe('the Exchange record', () => {
  it('is written once the reply completes, with when the gate answered and the first token came', async () => {
    const lines = await recorded(async (exchangeLog) => {
      exchangeLog.logGateAnswered('pass');
      exchangeLog.logFirstToken();
      return ok(reply(stopped('stop')));
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: 'exchange',
      userId: 'user-1',
      trigger: 'submit',
      verdict: 'pass',
      outcome: 'completed',
      errorCode: null,
      assistantMessageId: 'reply-1',
    });
    const [line] = lines;
    expect(line?.arrivedAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:]+\.\d{3}Z$/);
    expect(line?.verdictAfterMs).toBeGreaterThanOrEqual(0);
    expect(line?.firstTokenAfterMs).toBeGreaterThanOrEqual(line?.verdictAfterMs ?? 0);
    expect(line?.endedAfterMs).toBeGreaterThanOrEqual(line?.firstTokenAfterMs ?? 0);
  });

  it('leaves the gate and the first token empty for a request that never reached them', async () => {
    const [line] = await recorded(async () => err('thread_not_found'));

    expect(line).toMatchObject({
      outcome: 'refused',
      errorCode: 'thread_not_found',
      verdict: null,
      verdictAfterMs: null,
      firstTokenAfterMs: null,
      assistantMessageId: null,
    });
  });

  it.each([
    ['a reply stopped by the user', stopped('interrupted'), 'interrupted', null],
    [
      'a reply that went idle',
      err('stream_timeout', 'secret reply text'),
      'timed-out',
      'stream_timeout',
    ],
    ['a provider failure', err('provider_error'), 'failed', 'provider_error'],
  ] as const)('writes %s as %s', async (_name, settled, outcome, errorCode) => {
    const [line] = await recorded(async () => ok(reply(settled)));

    expect(line).toMatchObject({ outcome, errorCode, assistantMessageId: 'reply-1' });
  });

  it('writes a pause as soon as it is answered, with no reply', async () => {
    const [line] = await recorded(async (exchangeLog) => {
      exchangeLog.logGateAnswered('fire');
      return ok<Submission>({ paused: true });
    });

    expect(line).toMatchObject({ outcome: 'paused', verdict: 'fire', assistantMessageId: null });
  });

  it.each([
    ['gate_pending', 'gate-pending'],
    ['gate_failed', 'gate-failed'],
    ['budget_exceeded', 'refused'],
  ] as const)('writes a request answered %s as %s', async (code, outcome) => {
    const [line] = await recorded(async () => err(code));

    expect(line).toMatchObject({ outcome, errorCode: code });
  });

  it('writes a crash as a failure and lets it through', async () => {
    const crash = new Error('database down');

    await expect(
      recordingExchange({
        request,
        run: async () => {
          throw crash;
        },
      }),
    ).rejects.toBe(crash);

    expect(capture.written('exchange')).toMatchObject([
      { outcome: 'failed', errorCode: 'internal_error' },
    ]);
  });

  it('carries no text from an error message', async () => {
    await recorded(async () => err('stream_timeout', 'secret reply text'));

    expect(JSON.stringify(capture.written('exchange'))).not.toContain('secret');
  });
});
