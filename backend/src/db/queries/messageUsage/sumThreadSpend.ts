import { db } from '@db/db';
import { sql } from 'kysely';

/**
 * The one address for a thread's spend totals: the assistant exchanges'
 * chat telemetry, plus the arrival pipeline's embedding, rewrite, and
 * judge spend. Adding a spend source means adding it here (and its test),
 * so totals cannot silently under-count.
 */
export interface ThreadSpendTotals {
  chat: string;
  embedding: string;
  rewrite: string;
  judge: string;
}

/**
 * Totals the thread's spend per source. Sources without spend coalesce to
 * exact zero sums; results are decimal strings cast to the same
 * numeric(14,10) precision the rows store.
 */
export async function sumThreadSpend({
  threadId,
}: { threadId: string }): Promise<ThreadSpendTotals> {
  const [chat, expansion, embedding] = await Promise.all([
    db
      .selectFrom('messages as m')
      .innerJoin('messageUsage as mu', 'mu.messageId', 'm.id')
      .where('m.threadId', '=', threadId)
      .select(sql<string>`coalesce(sum(mu.cost_usd), 0)::numeric(14,10)`.as('chat'))
      .executeTakeFirst(),
    db
      .selectFrom('messages as m')
      .innerJoin('messageExpansionCosts as ec', 'ec.messageId', 'm.id')
      .where('m.threadId', '=', threadId)
      .select([
        sql<string>`coalesce(sum(ec.cost_usd) filter (where ec.kind = 'rewrite'), 0)::numeric(14,10)`.as(
          'rewrite',
        ),
        sql<string>`coalesce(sum(ec.cost_usd) filter (where ec.kind = 'judge'), 0)::numeric(14,10)`.as(
          'judge',
        ),
      ])
      .executeTakeFirst(),
    db
      .selectFrom('messages as m')
      .innerJoin('messageEmbeddings as me', 'me.messageId', 'm.id')
      .where('m.threadId', '=', threadId)
      .select(sql<string>`coalesce(sum(me.embedding_cost_usd), 0)::numeric(14,10)`.as('embedding'))
      .executeTakeFirst(),
  ]);

  const chatTotal = chat?.chat;
  const rewriteTotal = expansion?.rewrite;
  const judgeTotal = expansion?.judge;
  const embeddingTotal = embedding?.embedding;
  if (
    chatTotal === undefined ||
    rewriteTotal === undefined ||
    judgeTotal === undefined ||
    embeddingTotal === undefined
  ) {
    throw new Error('thread spend totals returned no row');
  }
  return { chat: chatTotal, embedding: embeddingTotal, rewrite: rewriteTotal, judge: judgeTotal };
}
