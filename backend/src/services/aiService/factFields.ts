import { FACT_CATEGORIES, type FactCategory } from '@db/types';

const MAX_ENTITY_CHARS = 120;

/** How a Fact is filed: what the memory model reads off its sentence. */
export interface FactFields {
  category: FactCategory;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  /** The date the Fact became true, when the text states it. */
  validAt: Date | null;
}

/** The filing rules every memory-model prompt shares, one rule per line. */
export const FACT_FIELD_RULES = `- category is one of: ${FACT_CATEGORIES.join(', ')}.
- subject is "user" when the fact is about the user; when it is about someone or something the user names, it is that name as the sentence writes it ("The user's sister Maria is a nurse" has subject "Maria"); predicate is a short snake_case verb phrase such as likes, lives_in, works_as; object is the thing, as the sentence writes it; use null when there is none.`;

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function trimmedOrNull(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
  return trimmed.slice(0, maxChars);
}

function normalizedPredicate(value: unknown): string | null {
  const text = trimmedOrNull(value, MAX_ENTITY_CHARS);
  if (text === null) return null;
  const snake = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return snake === '' ? null : snake;
}

function dayOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function categoryOrOther(value: unknown): FactCategory {
  return FACT_CATEGORIES.find((category) => category === value) ?? 'other';
}

/** The subject of a Fact about the user themselves. */
const USER_SUBJECT = 'user';

/** A subject as written; any spelling of "user" becomes the one marker. */
function subjectOrNull(value: unknown): string | null {
  const subject = trimmedOrNull(value, MAX_ENTITY_CHARS);
  return subject?.toLowerCase() === USER_SUBJECT ? USER_SUBJECT : subject;
}

/**
 * Reads filing fields off a model-written object; malformed fields fall
 * back to null or `other`. Names keep the spelling they were written in.
 */
export function factFieldsOf(raw: Record<string, unknown>): FactFields {
  return {
    category: categoryOrOther(raw.category),
    subject: subjectOrNull(raw.subject),
    predicate: normalizedPredicate(raw.predicate),
    object: trimmedOrNull(raw.object, MAX_ENTITY_CHARS),
    validAt: dayOrNull(raw.validAt),
  };
}

/**
 * The outermost JSON object in a model reply; null when there is none.
 * Tolerates code fences and prose around the object.
 */
export function jsonObjectOrNull(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  // Narrowed to a non-array object above; callers validate each field.
  return parsed as Record<string, unknown>;
}
