import { db } from '@db/db';

/**
 * What a Thread's Messages have been charged for side work, one entry per
 * (Message, kind, model) row, in a stable order. Two runs that paid for the
 * same work read equal.
 */
export async function sideCostsOfThread(threadId: string) {
  const rows = await db
    .selectFrom('billing.messageSideCosts as c')
    .innerJoin('chat.messages as m', 'm.id', 'c.messageId')
    .where('m.threadId', '=', threadId)
    .select(['c.kind', 'c.model', 'c.costUsd', 'c.promptTokens'])
    .execute();
  return rows
    .map((row) => ({
      kind: row.kind,
      model: row.model,
      costUsd: Number(row.costUsd),
      promptTokens: row.promptTokens,
    }))
    .sort((a, b) => `${a.kind}:${a.promptTokens}`.localeCompare(`${b.kind}:${b.promptTokens}`));
}
