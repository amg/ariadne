/** UUID v1–5 shape check. Postgres rejects malformed uuids at query time
 *  (22P02 → 500); route layers validate up front so bad ids get a clean 4xx. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}
