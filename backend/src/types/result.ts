/**
 * Minimal discriminated-union Result used at the provider/service boundary
 * (see features/ai-connector/MVP.md). Failures carry a stable `code` instead
 * of thrown exceptions leaking to the route layer.
 */

export type ResultSuccess<T> = { type: 'success'; data: T };

export type ResultError = { type: 'error'; code: string; message?: string };

export type Result<T> = ResultSuccess<T> | ResultError;

export function ok<T>(data: T): ResultSuccess<T> {
  return { type: 'success', data };
}

export function err(code: string, message?: string): ResultError {
  const result: ResultError = { type: 'error', code };
  if (message !== undefined) {
    result.message = message;
  }
  return result;
}
