import { db } from '@db/db';
import type { ExpansionCostKind, MessageExpansionCost, NewMessageExpansionCost } from '@db/types';

/** One expansion step spend; identity is `(messageId, kind)`. */
export type UpsertExpansionCostRow = {
  messageId: string;
  kind: ExpansionCostKind;
  model: string;
  costUsd: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
};

/**
 * Records one arrival expansion step's spend against the arrival message,
 * replacing any earlier record for the same `(messageId, kind)` — a
 * re-run of the step re-records its outcome, never duplicates it.
 */
export async function upsertExpansionCost(
  row: UpsertExpansionCostRow,
): Promise<MessageExpansionCost> {
  const values: NewMessageExpansionCost = {
    messageId: row.messageId,
    kind: row.kind,
    model: row.model,
    costUsd: row.costUsd,
    promptTokens: row.promptTokens ?? null,
    completionTokens: row.completionTokens ?? null,
  };
  return db
    .insertInto('messageExpansionCosts')
    .values(values)
    .onConflict((oc) =>
      oc.columns(['messageId', 'kind']).doUpdateSet({
        model: (eb) => eb.ref('excluded.model'),
        costUsd: (eb) => eb.ref('excluded.costUsd'),
        promptTokens: (eb) => eb.ref('excluded.promptTokens'),
        completionTokens: (eb) => eb.ref('excluded.completionTokens'),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}
