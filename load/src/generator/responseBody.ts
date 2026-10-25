/**
 * The body of a response; null when `signal` aborted before it was all
 * read. A body that failed for any other reason reads as empty.
 */
export async function bodyOrNull(response: Response, signal: AbortSignal) {
  try {
    return await response.text();
  } catch {
    return signal.aborted ? null : '';
  }
}
