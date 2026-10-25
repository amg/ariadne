import type { z } from 'zod';

/** A reader met a run folder whose schema version it does not know. */
export class UnknownSchemaVersion extends Error {
  readonly version: unknown;

  constructor(version: unknown, known: number) {
    super(
      `The run folder is at schema version ${JSON.stringify(version)}, which this reader does not know (it reads version ${known})`,
    );
    this.version = version;
  }
}

/** A line of a records file that is not valid JSON of the kind's schema. */
export class InvalidRecordLine extends Error {
  readonly line: number;

  constructor(kind: string, line: number, reason: string) {
    super(`Line ${line} of the ${kind} records is not valid: ${reason}`);
    this.line = line;
  }
}

/** One kind of record a run stores. */
export type RecordKind<Schema extends z.ZodType> = {
  readonly name: string;
  readonly schema: Schema;
  /** Validates `value` against the schema. */
  read: (value: unknown) => z.infer<Schema>;
  /** Validates every line of a JSON Lines file; blank lines are skipped. */
  readLines: (text: string) => z.infer<Schema>[];
  /**
   * Validates one line of a JSON Lines file, numbered from 1, for a reader
   * that goes through a file line by line; null for a blank line.
   */
  readLine: (line: string, number: number) => z.infer<Schema> | null;
};

/**
 * Defines a record kind. A change to its schema that old files do not
 * satisfy raises the run folder's schema version.
 */
export function recordKind<Schema extends z.ZodType>(
  name: string,
  schema: Schema,
): RecordKind<Schema> {
  const readLine = (line: string, number: number): z.infer<Schema> | null => {
    if (line.trim() === '') return null;
    const parsed = schema.safeParse(parseJson(name, line, number));
    if (!parsed.success) throw new InvalidRecordLine(name, number, parsed.error.message);
    return parsed.data;
  };
  return {
    name,
    schema,
    read: (value) => schema.parse(value),
    readLine,
    readLines: (text) => readEachLine(text, readLine),
  };
}

/**
 * What `readLine` makes of each line of `text`, numbered from 1, without the
 * blank ones. Lines are cut out one at a time, so a text of many lines is
 * not copied into many arrays on the way.
 */
function readEachLine<Item>(
  text: string,
  readLine: (line: string, number: number) => Item | null,
): Item[] {
  const items: Item[] = [];
  let number = 0;
  for (let start = 0; start <= text.length; ) {
    const found = text.indexOf('\n', start);
    const end = found === -1 ? text.length : found;
    number += 1;
    const item = readLine(text.slice(start, end), number);
    if (item !== null) items.push(item);
    start = end + 1;
  }
  return items;
}

function parseJson(kind: string, line: string, number: number) {
  try {
    return JSON.parse(line);
  } catch {
    throw new InvalidRecordLine(kind, number, 'not JSON');
  }
}
