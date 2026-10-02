/**
 * Minimal discriminated-union Result used at the provider/service boundary
 *. Failures carry a stable `code` instead
 * of thrown exceptions leaking to the route layer.
 */

export type ResultSuccess<T> = { type: 'success'; data: T };

/** Budget exceeded error — always includes retryAfter (seconds until UTC midnight). */
export type BudgetExceededError = {
  type: 'error';
  code: 'budget_exceeded';
  message: string;
  retryAfter: number;
};

/** Standard error — just code + optional message. */
export type StandardError = {
  type: 'error';
  code: string;
  message?: string;
};

export type ResultError = StandardError | BudgetExceededError;

export type Result<T> = ResultSuccess<T> | ResultError;

export function ok<T>(data: T): ResultSuccess<T> {
  return { type: 'success', data };
}

export function err(code: string, message?: string): StandardError {
  const result: StandardError = { type: 'error', code };
  if (message !== undefined) {
    result.message = message;
  }
  return result;
}

/** Specialized error constructor for budget exceeded (includes retryAfter). */
export function errBudgetExceeded(
  retryAfterSeconds: number,
  message?: string,
): BudgetExceededError {
  return {
    type: 'error',
    code: 'budget_exceeded',
    message: message ?? 'Daily spend budget exceeded. Try again after UTC midnight.',
    retryAfter: retryAfterSeconds,
  };
}
