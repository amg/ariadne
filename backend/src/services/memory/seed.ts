import type { SeedLine } from '@db/types';
import { findThreadSeedByThreadIdOrNull } from '@queries/threadSeeds/findThreadSeedByThreadId';
import { insertThreadSeed } from '@queries/threadSeeds/insertThreadSeed';
import {
  type SeedableUserFact,
  listSeedableUserFacts,
} from '@queries/userFacts/listSeedableUserFacts';
import { countTextTokens } from '@services/aiService';
import { getUserSettings } from '@services/settingsService';
import type { MemoryFeature } from './memoryFeature';

/** The most prompt tokens a Seed's memory block may take. */
export const SEED_TOKEN_BUDGET = 800;
/** Facts read per snapshot; well past what the budget can hold. */
const SEED_CANDIDATE_LIMIT = 200;

const SEED_HEADER =
  'What you know about the user from earlier conversations, newest first. A date before a fact is when it became true, or when it was noted if no such date is known; when two facts disagree, the newer one wins. The list may be incomplete. Use these facts when they help, without mentioning that you remember them.';

export interface RenderedSeed {
  lines: SeedLine[];
  factCount: number;
}

/** A Seed with nothing to say; a handed-over Thread records one all the same. */
export const EMPTY_SEED: RenderedSeed = { lines: [], factCount: 0 };

/**
 * The lines of a Seed: a bullet per Fact, dated by its stated date, or by
 * when it was noted when none was stated, in the order given, stopping
 * before the token budget (header included) is exceeded. Null when no
 * Fact fits.
 */
export function renderedSeedOrNull(
  facts: SeedableUserFact[],
  tokenBudget: number = SEED_TOKEN_BUDGET,
): RenderedSeed | null {
  const lines: SeedLine[] = [];
  let tokens = countTextTokens(SEED_HEADER);
  for (const fact of facts) {
    const date = (fact.validAt ?? fact.createdAt).toISOString().slice(0, 10);
    const text = `- ${date}: ${fact.content}`;
    const lineTokens = countTextTokens(text) + 1;
    if (tokens + lineTokens > tokenBudget) break;
    tokens += lineTokens;
    lines.push({ category: fact.category, text });
  }
  if (lines.length === 0) return null;
  return { lines, factCount: lines.length };
}

/**
 * The Seed a Thread opened now would freeze: what the Memory knows about
 * the user, rendered. Empty while memory is off or holds nothing seedable.
 */
export async function currentSeed({ userId }: { userId: string }): Promise<RenderedSeed> {
  const settings = await getUserSettings({ userId });
  const facts = settings.memoryEnabled
    ? await listSeedableUserFacts({
        userId,
        blockedCategories: settings.memoryBlockedCategories,
        limit: SEED_CANDIDATE_LIMIT,
      })
    : [];
  return renderedSeedOrNull(facts) ?? EMPTY_SEED;
}

/**
 * Freezes a fresh Thread's Seed from what the Memory knows about the user
 * right now; no Seed when there is nothing to say. Handover Threads record
 * theirs with the move itself.
 */
export async function seedThread({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}): Promise<void> {
  const seed = await currentSeed({ userId });
  if (seed.factCount === 0) return;
  await insertThreadSeed({ threadId, ...seed, handoverMessageId: null });
}

/**
 * The system prompt an Exchange runs with: the base prompt, followed by
 * the Thread's Seed while memory is on, minus any category blocked since
 * the Seed froze. Identical on every Exchange of the Thread as long as the
 * settings stay put. A deployment without Memory gets the base prompt.
 */
export async function assembledSystemPrompt({
  userId,
  threadId,
  basePrompt,
  memory,
}: {
  userId: string;
  threadId: string;
  basePrompt: string;
  memory: MemoryFeature;
}): Promise<string> {
  if (memory.kind === 'off') return basePrompt;
  const seed = await findThreadSeedByThreadIdOrNull({ threadId });
  if (seed === null || seed.lines.length === 0) return basePrompt;
  const settings = await getUserSettings({ userId });
  if (!settings.memoryEnabled) return basePrompt;
  const shown = seed.lines.filter(
    (line) => !settings.memoryBlockedCategories.includes(line.category),
  );
  if (shown.length === 0) return basePrompt;
  return [`${basePrompt}\n\n${SEED_HEADER}`, ...shown.map((line) => line.text)].join('\n');
}
