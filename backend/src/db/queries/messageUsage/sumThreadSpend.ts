import { db } from '@db/db';
import { sql } from 'kysely';

/**
 * The one address for a thread's spend totals: the assistant exchanges'
 * chat telemetry, plus the arrival pipeline's embedding, rewrite, and
 * judge spend, plus the Fact capture its Boundary arrivals triggered. Adding a spend source means adding it here (and its test),
 * so totals cannot silently under-count.
 */
export interface ThreadSpendTotals {
  chat: string;
  embedding: string;
  rewrite: string;
  judge: string;
  /** Fact extraction, duplicate checks, and Fact embeddings. */
  memory: string;
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
      .selectFrom('chat.messages as m')
      .innerJoin('billing.messageUsage as mu', 'mu.messageId', 'm.id')
      .where('m.threadId', '=', threadId)
      .select(sql<string>`coalesce(sum(mu.cost_usd), 0)::numeric(14,10)`.as('chat'))
      .executeTakeFirst(),
    db
      .selectFrom('chat.messages as m')
      .innerJoin('billing.messageSideCosts as ec', 'ec.messageId', 'm.id')
      .where('m.threadId', '=', threadId)
      .select([
        sql<string>`coalesce(sum(ec.cost_usd) filter (where ec.kind = 'rewrite'), 0)::numeric(14,10)`.as(
          'rewrite',
        ),
        sql<string>`coalesce(sum(ec.cost_usd) filter (where ec.kind = 'judge'), 0)::numeric(14,10)`.as(
          'judge',
        ),
        sql<string>`coalesce(sum(ec.cost_usd) filter (where ec.kind in ('fact_extraction', 'fact_duplicate_check', 'fact_embedding')), 0)::numeric(14,10)`.as(
          'memory',
        ),
      ])
      .executeTakeFirst(),
    db
      .selectFrom('chat.messages as m')
      .innerJoin('analysis.messageEmbeddings as me', 'me.messageId', 'm.id')
      .where('m.threadId', '=', threadId)
      .select(sql<string>`coalesce(sum(me.embedding_cost_usd), 0)::numeric(14,10)`.as('embedding'))
      .executeTakeFirst(),
  ]);

  const chatTotal = chat?.chat;
  const rewriteTotal = expansion?.rewrite;
  const judgeTotal = expansion?.judge;
  const embeddingTotal = embedding?.embedding;
  const memoryTotal = expansion?.memory;
  if (
    chatTotal === undefined ||
    rewriteTotal === undefined ||
    judgeTotal === undefined ||
    embeddingTotal === undefined ||
    memoryTotal === undefined
  ) {
    throw new Error('thread spend totals returned no row');
  }
  return {
    chat: chatTotal,
    embedding: embeddingTotal,
    rewrite: rewriteTotal,
    judge: judgeTotal,
    memory: memoryTotal,
  };
}
