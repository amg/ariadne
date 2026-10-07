import { listMessagesByThread } from '@queries/messages/listMessagesByThread';
import { listThreadsByUser } from '@queries/threads/listThreadsByUser';
import { findDriftGateJudgeArrivalJobOrNull } from '@queue/tasks/driftGateJudgeArrivalTask';
import { judgmentFailed, storedGateOutcomeOrNull } from '@services/aiService/arrivalGate';
import type { ServerEvent } from './serverEvent';

/**
 * Where each of the user's arrivals stands right now, as ordinary events:
 * a Paused arrival reports its fire, a judged-clear one its verdict, and
 * one whose judgment gave up with a fatal failure reports that. An arrival
 * still being judged contributes nothing — its next attempt delivers the
 * news. Intended for a connection that has just opened, so a late browser
 * handles what it missed with the same code as live news.
 */
export async function currentArrivalEvents(userId: string): Promise<ServerEvent[]> {
  const threads = await listThreadsByUser({ userId });
  const events: ServerEvent[] = [];

  for (const thread of threads) {
    const rows = await listMessagesByThread({ threadId: thread.id });
    // A thread owes at most one arrival: its newest live row, when that is
    // a user Message.
    const arrival = rows.filter((row) => !row.abandoned).at(-1);
    if (!arrival || arrival.role !== 'user') continue;
    const { id: messageId } = arrival;

    const stored = await storedGateOutcomeOrNull(messageId);
    if (stored?.kind === 'paused') {
      events.push({
        kind: 'verdict-paused',
        userId,
        threadId: thread.id,
        messageId,
        fireChannel: stored.verdict.fireChannel,
      });
      continue;
    }
    if (stored) {
      // A stored clear reading is pass or muted; a fire lands as paused
      // and never here.
      const clear = stored.verdict?.verdict;
      events.push({
        kind: 'verdict-ok',
        userId,
        threadId: thread.id,
        messageId,
        verdict: clear === 'pass' || clear === 'muted' ? clear : null,
      });
      continue;
    }

    if (judgmentFailed(await findDriftGateJudgeArrivalJobOrNull(messageId))) {
      events.push({ kind: 'gate-failed', userId, threadId: thread.id, messageId });
    }
  }

  return events;
}
