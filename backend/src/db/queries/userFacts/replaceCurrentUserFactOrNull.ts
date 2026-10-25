import type { NewUserFact } from '@db/types';
import { NoResultError } from 'kysely';
import { updateUserFact } from './updateUserFact';

type ReplaceCurrentUserFactProps = {
  factId: string;
  userId: string;
  /** The row that supersedes the Fact. */
  replacement: Omit<NewUserFact, 'userId'>;
};

/**
 * Supersedes a current Fact with a new row. Null, with nothing written,
 * when the Fact is missing or already superseded.
 */
export async function replaceCurrentUserFactOrNull(props: ReplaceCurrentUserFactProps) {
  try {
    return await updateUserFact(props);
  } catch (error) {
    if (error instanceof NoResultError) return null;
    throw error;
  }
}
