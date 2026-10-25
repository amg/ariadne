import { type LineSink, linesOfFile } from './lines.ts';

const PREFIXES = { REQUEST: 'requests', STATE: 'states' } as const;

/** The key a record sits under in a line that also carries metric fields. */
const KEYS = { request: 'requests', state: 'states' } as const;

/** Where a line of generator output goes: one of the lists, or the report. */
type Place = 'requests' | 'states' | 'report' | 'rest';

/**
 * A request or state record from a line that is one JSON object, the
 * record under its key and metric fields beside it; null for any other line.
 */
function recordOfJsonLineOrNull(line: string) {
  if (!line.startsWith('{"request":') && !line.startsWith('{"state":')) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return null;
    for (const [key, list] of Object.entries(KEYS)) {
      const record = Object.entries(parsed).find(([name]) => name === key)?.[1];
      if (typeof record === 'object' && record !== null) {
        return { list, payload: JSON.stringify(record) };
      }
    }
  } catch {
    // A line cut short is no record; it stays with the rest.
  }
  return null;
}

/**
 * Where a whole line of output goes, and what of it is kept there. A
 * request or state line is either a marker followed by the record, or one
 * JSON object that carries the record beside its metric fields; either way
 * only the record is kept.
 */
function placeOf(line: string): { place: Place; payload: string } {
  const record = recordOfJsonLineOrNull(line);
  if (record !== null) return { place: record.list, payload: record.payload };
  const separator = line.indexOf(' ');
  const prefix = separator === -1 ? '' : line.slice(0, separator);
  const payload = line.slice(separator + 1);
  if (prefix === 'REQUEST' || prefix === 'STATE') return { place: PREFIXES[prefix], payload };
  if (prefix === 'REPORT') return { place: 'report', payload };
  return { place: 'rest', payload: line };
}

/**
 * Sorts a generator's output in a file into the sinks of its request lines,
 * state lines and the rest, a line at a time, so that output of any size is
 * sorted with the memory of one line. A last line that a newline did not
 * end may be half of one, so it stays with the rest. The report is found
 * apart, by `reportInFile`.
 */
export async function sortGeneratorOutputFile(
  file: string,
  sinks: Readonly<Record<'requests' | 'states' | 'rest', LineSink>>,
): Promise<void> {
  for await (const { text, complete } of linesOfFile(file)) {
    if (!complete) {
      await sinks.rest.write(text);
      continue;
    }
    const { place, payload } = placeOf(text);
    if (place !== 'report') await sinks[place].write(payload);
  }
}

/** The last report a generator printed into a file, as the JSON it printed; null when it printed none. */
export async function reportInFile(file: string) {
  let report: string | null = null;
  for await (const { text, complete } of linesOfFile(file)) {
    if (!complete || !text.startsWith('REPORT ')) continue;
    const { place, payload } = placeOf(text);
    if (place === 'report') report = payload;
  }
  return report;
}
