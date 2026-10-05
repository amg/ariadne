import type { UserFact } from '@/services/api';
import { factRecencyMs } from './factDates';

const USER_SUBJECT = 'user';

export interface FactGroup {
  key: string;
  heading: string;
  facts: UserFact[];
}

interface RankedFactGroup {
  group: FactGroup;
  subjectRank: number;
  newestFactMs: number;
}

function normalizedSubjectOrNull(subject: string | null): string | null {
  const normalized = subject?.trim().toLowerCase() ?? '';
  return normalized === '' ? null : normalized;
}

function capitalizedWords(text: string): string {
  return text
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function subjectHeading(subject: string | null): string {
  if (subject === null) return 'Unspecified';
  if (subject === USER_SUBJECT) return 'About: The User';
  return `About: ${capitalizedWords(subject)}`;
}

/** The user comes first, named entities next, facts without a subject last. */
function subjectRank(subject: string | null): number {
  if (subject === null) return 2;
  return subject === USER_SUBJECT ? 0 : 1;
}

function byNewestFact(a: UserFact, b: UserFact): number {
  return factRecencyMs(b) - factRecencyMs(a);
}

function byGroupOrder(a: RankedFactGroup, b: RankedFactGroup): number {
  return (
    a.subjectRank - b.subjectRank ||
    b.newestFactMs - a.newestFactMs ||
    b.group.facts.length - a.group.facts.length ||
    a.group.heading.localeCompare(b.group.heading)
  );
}

/**
 * Facts clustered by the entity they describe. Groups are ordered user
 * first and Unspecified last, then by newest fact, then by size; facts
 * inside a group are newest first. A fact's recency is its stated date,
 * or when it was noted. Subjects match case-insensitively.
 */
export function factGroupsBySubject(facts: UserFact[]): FactGroup[] {
  const factsBySubject = new Map<string | null, UserFact[]>();
  for (const fact of facts) {
    const subject = normalizedSubjectOrNull(fact.subject);
    factsBySubject.set(subject, [...(factsBySubject.get(subject) ?? []), fact]);
  }

  return [...factsBySubject.entries()]
    .map(([subject, subjectFacts]) => ({
      group: {
        key: subject === null ? 'unspecified' : `about:${subject}`,
        heading: subjectHeading(subject),
        facts: [...subjectFacts].sort(byNewestFact),
      },
      subjectRank: subjectRank(subject),
      newestFactMs: Math.max(...subjectFacts.map(factRecencyMs)),
    }))
    .sort(byGroupOrder)
    .map(({ group }) => group);
}
