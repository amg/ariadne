import type { Kysely } from 'kysely';

/**
 * Add `estimated_reasoning_tokens` column to `message_usage` table.
 *
 * Purpose: Track reasoning token count independently of provider reporting.
 * DeepInfra lumps reasoning tokens into textTokens and reports 0, so we
 * estimate from the actual reasoning content length.
 *
 * Column semantics:
 * - NULL: No reasoning content was generated
 * - VALUE: Estimated token count from reasoning text (js-tiktoken)
 *
 * Note: This is separate from `reasoning_tokens` which stores the provider's
 * report (DeepInfra reports 0, other providers may report actual counts).
 */
export async function up(db: Kysely<unknown>) {
  await db.schema
    .alterTable('message_usage')
    .addColumn('estimated_reasoning_tokens', 'integer')
    .execute();
}

export async function down(db: Kysely<unknown>) {
  await db.schema.alterTable('message_usage').dropColumn('estimated_reasoning_tokens').execute();
}
