import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LAYOUT, type RunEvent, eventSchema } from '../records/index.ts';

/** Appends one JSON line to a file of the run folder, making the folders on the way. */
export function appendJsonLine(folder: string, path: string, record: object) {
  const file = join(folder, path);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/** Records something that happened in the run, stamped with the wall clock now unless it carries a time. */
export function recordEvent(
  folder: string,
  event: DistributiveOmit<RunEvent, 'at'> & { at?: string },
) {
  appendJsonLine(
    folder,
    LAYOUT.events,
    eventSchema.parse({ at: new Date().toISOString(), ...event }),
  );
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
