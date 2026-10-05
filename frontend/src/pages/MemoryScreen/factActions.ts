import { type UserFact, deleteUserFact, updateUserFact } from '@/services/api';
import { toast } from 'sonner';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pluralFacts(count: number): string {
  return count === 1 ? '1 fact' : `${count} facts`;
}

function reportBulkOutcome(results: PromiseSettledResult<unknown>[], pastTenseVerb: string): void {
  const failedCount = results.filter((result) => result.status === 'rejected').length;
  if (failedCount === 0) {
    toast.success(`${pluralFacts(results.length)} ${pastTenseVerb}`);
    return;
  }
  toast.error(`${failedCount} of ${pluralFacts(results.length)} could not be ${pastTenseVerb}`);
}

/** Flips a Fact's suppression. Resolves true when the change was saved. */
export async function toggleFactSuppressed(fact: UserFact): Promise<boolean> {
  try {
    await updateUserFact(fact.id, { suppressed: !fact.suppressed });
    toast.success(fact.suppressed ? 'Fact unsuppressed' : 'Fact suppressed');
    return true;
  } catch (error) {
    toast.error('Failed to update fact', { description: errorMessage(error) });
    return false;
  }
}

/** Replaces a Fact's sentence. Resolves true when the change was saved. */
export async function editFactContent(fact: UserFact, content: string): Promise<boolean> {
  if (content.trim() === '') {
    toast.error('Content cannot be empty');
    return false;
  }
  try {
    await updateUserFact(fact.id, { content });
    toast.success('Fact updated');
    return true;
  } catch (error) {
    toast.error('Failed to update fact', { description: errorMessage(error) });
    return false;
  }
}

/** Permanently removes a Fact. Resolves true when it was deleted. */
export async function deleteFact(fact: UserFact): Promise<boolean> {
  try {
    await deleteUserFact(fact.id);
    toast.success('Fact deleted');
    return true;
  } catch (error) {
    toast.error('Failed to delete fact', { description: errorMessage(error) });
    return false;
  }
}

/** Brings every given Fact to the requested suppression state; partial failures are reported. */
export async function setFactsSuppressed(facts: UserFact[], suppressed: boolean): Promise<void> {
  const changing = facts.filter((fact) => fact.suppressed !== suppressed);
  const results = await Promise.allSettled(
    changing.map((fact) => updateUserFact(fact.id, { suppressed })),
  );
  reportBulkOutcome(results, suppressed ? 'suppressed' : 'unsuppressed');
}

/** Permanently removes every given Fact; partial failures are reported. */
export async function deleteFacts(facts: UserFact[]): Promise<void> {
  const results = await Promise.allSettled(facts.map((fact) => deleteUserFact(fact.id)));
  reportBulkOutcome(results, 'deleted');
}
