import { db } from '@db/db';
import type { MessageSideCost, SideCostKind } from '@db/types';

type GetSideCostByMessageIdProps = {
  messageId: string;
  kind: SideCostKind;
  /** Which model's spend row to read; kinds whose model can vary need it. */
  model: string;
};

/** One side-pipeline spend row for a message under its model, when present. */
export async function getSideCostByMessageId({
  messageId,
  kind,
  model,
}: GetSideCostByMessageIdProps): Promise<MessageSideCost | undefined> {
  return db
    .selectFrom('billing.messageSideCosts')
    .selectAll()
    .where('messageId', '=', messageId)
    .where('kind', '=', kind)
    .where('model', '=', model)
    .executeTakeFirst();
}
