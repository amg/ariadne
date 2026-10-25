import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Finding } from '../../records/index.ts';
import { findingKeeper, keptFindings } from './keptFindings.ts';

const finding = (detail: string): Finding => ({ check: 'sources-collected', detail, path: null });

const folderOf = () => mkdtempSync(join(tmpdir(), 'findings-'));

const hold = (folder: string, file: string) => {
  mkdirSync(dirname(join(folder, file)), { recursive: true });
  writeFileSync(join(folder, file), 'x');
};

describe('findingKeeper', () => {
  it('keeps each finding once', () => {
    const folder = folderOf();
    hold(folder, 'events/aws-events.jsonl');
    const { keep } = findingKeeper(folder);

    keep('events/aws-events.jsonl', [finding('a')]);
    keep('events/aws-events.jsonl', [finding('a'), finding('b')]);

    expect(keptFindings(folder).map((kept) => kept.detail)).toEqual(['a', 'b']);
  });

  it('reads only the findings about files the folder holds', () => {
    const folder = folderOf();
    hold(folder, 'events/events.jsonl');
    const { keep } = findingKeeper(folder);
    keep('events/events.jsonl', [finding('kept')]);
    keep('events/aws-events.jsonl', [finding('about a file that is not here')]);

    expect(keptFindings(folder).map((kept) => kept.detail)).toEqual(['kept']);
  });
});
