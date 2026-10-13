import { db } from '@db/db';
import type { SideCostKind } from '@db/types';

export type AddSideCostRow = {
  messageId: string;
  kind: SideCostKind;
  model: string;
  /** USD as a decimal string; must be a finite, non-negative number. */
  costUsd: string;
  /** Null when the provider reported no count. */
  promptTokens: number | null;
  completionTokens: number | null;
};

/**
 * Adds spend to the `(messageId, kind, model)` row, creating it on first
 * use: a repeated run accumulates what it burned instead of replacing
 * the earlier record. A null token count means unknown: added to a known
 * count it leaves that count as it is, and two unknowns stay unknown.
 * Throws on a cost that is not a finite, non-negative number, since one
 * NaN would poison the row's total for good.
 */
export async function addSideCost(row: AddSideCostRow): Promise<void> {
  const cost = Number(row.costUsd);
  if (row.costUsd.trim() === '' || !Number.isFinite(cost) || cost < 0) {
    throw new Error(`addSideCost: invalid costUsd "${row.costUsd}" for ${row.kind}`);
  }

  await db
    .insertInto('billing.messageSideCosts')
    .values(row)
    .onConflict((oc) =>
      oc.columns(['messageId', 'kind', 'model']).doUpdateSet((eb) => {
        // coalesce(a + b, a, b): the sum when both are known, else
        // whichever is known, else null.
        const summed = (
          stored:
            | 'billing.messageSideCosts.promptTokens'
            | 'billing.messageSideCosts.completionTokens',
          added: 'excluded.promptTokens' | 'excluded.completionTokens',
        ) => eb.fn.coalesce(eb(stored, '+', eb.ref(added)), eb.ref(stored), eb.ref(added));
        return {
          model: eb.ref('excluded.model'),
          costUsd: eb('billing.messageSideCosts.costUsd', '+', eb.ref('excluded.costUsd')),
          promptTokens: summed('billing.messageSideCosts.promptTokens', 'excluded.promptTokens'),
          completionTokens: summed(
            'billing.messageSideCosts.completionTokens',
            'excluded.completionTokens',
          ),
        };
      }),
    )
    .execute();
}
