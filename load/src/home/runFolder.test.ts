import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventRecords } from '../records/event.ts';
import { LAYOUT } from '../records/layout.ts';
import { appendJsonLine, recordEvent } from './runFolder.ts';

const folderOf = () => mkdtempSync(join(tmpdir(), 'run-folder-'));

describe('appendJsonLine', () => {
  it('adds one line per call, making the folders on the way', () => {
    const folder = folderOf();

    appendJsonLine(folder, 'metrics/a.jsonl', { n: 1 });
    appendJsonLine(folder, 'metrics/a.jsonl', { n: 2 });

    expect(readFileSync(join(folder, 'metrics/a.jsonl'), 'utf8')).toBe('{"n":1}\n{"n":2}\n');
  });
});

describe('recordEvent', () => {
  it('stamps an event with the wall clock now, in UTC with milliseconds', () => {
    const folder = folderOf();

    recordEvent(folder, { kind: 'run-started' });

    const [event] = eventRecords.readLines(readFileSync(join(folder, LAYOUT.events), 'utf8'));
    expect(event?.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('keeps the time an event carries', () => {
    const folder = folderOf();

    recordEvent(folder, { kind: 'run-started', at: '2026-10-15T00:00:00.000Z' });

    expect(readFileSync(join(folder, LAYOUT.events), 'utf8')).toContain('2026-10-15T00:00:00.000Z');
  });

  it('refuses an event that is not of a known kind', () => {
    // @ts-expect-error The kind is not one the records know.
    expect(() => recordEvent(folderOf(), { kind: 'nonsense' })).toThrow();
  });
});
