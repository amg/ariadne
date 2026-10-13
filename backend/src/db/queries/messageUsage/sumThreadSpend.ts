import { db } from '@db/db';
import { sql } from 'kysely';

/**
 * The one address for a thread's spend totals: the assistant exchanges'
 * chat telemetry, plus every side call billed against the thread's
 * messages — the arrival pipeline's embeddings, rewrites, and judges,
 * and the Fact capture its Boundary arrivals triggered. Adding a spend
 * source means adding it here (and its test), so totals cannot silently
 * under-count.
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
}: {
  threadId: string;
}): Promise<ThreadSpendTotals> {
  // The numeric(14,10) cast has no builder literal, so it rides a raw
  // fragment around the typed aggregates.
  const [chat, sides] = await Promise.all([
    db
      .selectFrom('chat.messages as m')
      .innerJoin('billing.messageUsage as mu', 'mu.messageId', 'm.id')
      .where('m.threadId', '=', threadId)
      .select((eb) =>
        sql<string>`${eb.fn.coalesce(eb.fn.sum('mu.costUsd'), eb.val(0))}::numeric(14,10)`.as(
          'chat',
        ),
      )
      .executeTakeFirst(),
    db
      .selectFrom('chat.messages as m')
      .innerJoin('billing.messageSideCosts as sc', 'sc.messageId', 'm.id')
      .where('m.threadId', '=', threadId)
      .select((eb) => [
        sql<string>`${eb.fn.coalesce(
          eb.fn.sum('sc.costUsd').filterWhere('sc.kind', '=', 'embedding'),
          eb.val(0),
        )}::numeric(14,10)`.as('embedding'),
        sql<string>`${eb.fn.coalesce(
          eb.fn.sum('sc.costUsd').filterWhere('sc.kind', '=', 'rewrite'),
          eb.val(0),
        )}::numeric(14,10)`.as('rewrite'),
        sql<string>`${eb.fn.coalesce(
          eb.fn.sum('sc.costUsd').filterWhere('sc.kind', '=', 'judge'),
          eb.val(0),
        )}::numeric(14,10)`.as('judge'),
        sql<string>`${eb.fn.coalesce(
          eb.fn
            .sum('sc.costUsd')
            .filterWhere('sc.kind', 'in', [
              'fact_extraction',
              'fact_duplicate_check',
              'fact_embedding',
            ]),
          eb.val(0),
        )}::numeric(14,10)`.as('memory'),
      ])
      .executeTakeFirst(),
  ]);

  const chatTotal = chat?.chat;
  const embeddingTotal = sides?.embedding;
  const rewriteTotal = sides?.rewrite;
  const judgeTotal = sides?.judge;
  const memoryTotal = sides?.memory;
  if (
    chatTotal === undefined ||
    embeddingTotal === undefined ||
    rewriteTotal === undefined ||
    judgeTotal === undefined ||
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
