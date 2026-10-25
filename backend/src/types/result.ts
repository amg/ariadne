type ResultSuccess<T> = { type: 'success'; data: T };

/** Budget exceeded error — always includes retryAfter (seconds until UTC midnight). */
type BudgetExceededError = {
  type: 'error';
  code: 'budget_exceeded';
  message: string;
  retryAfter: number;
};

/** Standard error — just code + optional message. */
type StandardError = {
  type: 'error';
  code: string;
  message?: string;
};

export type ResultError = StandardError | BudgetExceededError;

/**
 * A discriminated-union result for service calls. Failures carry a stable
 * `code` instead of throwing to the route layer.
 */
export type Result<T> = ResultSuccess<T> | ResultError;

export function ok<T>(data: T): ResultSuccess<T> {
  return { type: 'success', data };
}

export function err(code: string, message?: string) {
  const result: StandardError = { type: 'error', code };
  if (message !== undefined) {
    result.message = message;
  }
  return result;
}

/** Specialized error constructor for budget exceeded (includes retryAfter). */
export function errBudgetExceeded(retryAfterSeconds: number): BudgetExceededError {
  return {
    type: 'error',
    code: 'budget_exceeded',
    message: 'Daily spend budget exceeded. Try again after UTC midnight.',
    retryAfter: retryAfterSeconds,
  };
}
