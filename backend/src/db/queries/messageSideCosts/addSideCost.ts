import { db } from '@db/db';
import type { SideCostKind } from '@db/types';

export type AddSideCostRow = {
  messageId: string;
  kind: SideCostKind;
  model: string;
  costUsd: string;
  promptTokens: number;
  completionTokens: number;
};

/**
 * Adds spend to the `(messageId, kind)` row, creating it on first use: a
 * repeated run accumulates what it burned instead of replacing the
 * earlier record.
 */
export async function addSideCost(row: AddSideCostRow): Promise<void> {
  await db
    .insertInto('messageSideCosts')
    .values(row)
    .onConflict((oc) =>
      oc.columns(['messageId', 'kind']).doUpdateSet((eb) => ({
        model: eb.ref('excluded.model'),
        costUsd: eb('messageSideCosts.costUsd', '+', eb.ref('excluded.costUsd')),
        promptTokens: eb(
          eb.fn.coalesce('messageSideCosts.promptTokens', eb.lit(0)),
          '+',
          eb.ref('excluded.promptTokens'),
        ),
        completionTokens: eb(
          eb.fn.coalesce('messageSideCosts.completionTokens', eb.lit(0)),
          '+',
          eb.ref('excluded.completionTokens'),
        ),
      })),
    )
    .execute();
}
