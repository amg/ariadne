/** Orders text by its characters alone, so that a sorted list reads the same on every machine. */
export function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
