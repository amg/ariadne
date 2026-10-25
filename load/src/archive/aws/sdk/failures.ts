import { SourceUnavailable } from '../sources.ts';

/**
 * Runs a call that reads something the raise may no longer hold. An
 * error with one of the given names says the thing is gone, and becomes
 * `SourceUnavailable`; any other error is a failure to retry later.
 */
export async function orUnavailable<Result>(
  what: string,
  goneErrors: readonly string[],
  call: () => Promise<Result>,
): Promise<Result> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Error && goneErrors.includes(error.name)) {
      throw new SourceUnavailable(`${what} is gone (${error.name}: ${error.message})`);
    }
    throw error;
  }
}

/** Stops the archive when ECS says it could not describe something that was asked for. */
export function assertDescribed(
  what: string,
  failures: readonly { arn?: string; reason?: string; detail?: string }[] | undefined,
) {
  if (failures === undefined || failures.length === 0) return;
  const said = failures
    .map(
      (failure) =>
        `${failure.arn ?? 'unknown'}: ${failure.reason ?? 'no reason'}${failure.detail ? ` (${failure.detail})` : ''}`,
    )
    .join('; ');
  throw new Error(`ECS could not describe ${what}: ${said}`);
}

export const instantOrNull = (date: Date | undefined) => date?.toISOString() ?? null;
