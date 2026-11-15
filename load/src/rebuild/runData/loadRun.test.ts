import { createHash } from 'node:crypto';
import { constants } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAYOUT } from '../../records/index.ts';
import { loadRun } from './loadRun.ts';
import { exchangeWith, manifestWith } from './testing.ts';

const exchange = JSON.stringify(exchangeWith());

const STRING_MAX_LENGTH = constants.MAX_STRING_LENGTH;

/** A run folder holding the given files, sealed by a manifest that lists them. */
function sealedFolder(files: Record<string, Buffer | string>) {
  const folder = mkdtempSync(join(tmpdir(), 'load-run-'));
  const entries = Object.entries(files).map(([path, content]) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), content);
    const bytes = Buffer.from(content);
    return {
      path,
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  const manifest = manifestWith({ target: 'aws-prod', files: entries });
  writeFileSync(join(folder, LAYOUT.manifest), JSON.stringify(manifest));
  return folder;
}

describe('loadRun', () => {
  it('reads the files the manifest lists', () => {
    const folder = sealedFolder({ [LAYOUT.exchanges]: `${exchange}\n` });

    const data = loadRun(folder);

    expect(data.exchanges).toHaveLength(1);
    expect(data.trouble).toEqual([]);
  });

  it('reads a file longer than the longest string the runtime can hold', () => {
    const blankLine = Buffer.from(`${' '.repeat(1024 * 1024 - 1)}\n`);
    const blankLines = Math.ceil(STRING_MAX_LENGTH / blankLine.byteLength);
    const content = Buffer.concat([
      ...Array.from({ length: blankLines }, () => blankLine),
      Buffer.from(`${exchange}\n`),
    ]);
    expect(content.byteLength).toBeGreaterThan(STRING_MAX_LENGTH);
    const folder = sealedFolder({ [LAYOUT.exchanges]: content });

    const data = loadRun(folder);
    rmSync(folder, { recursive: true });

    expect(data.exchanges).toHaveLength(1);
    expect(data.trouble).toEqual([]);
  }, 60_000);

  it('reports a line that is not a record of its kind, naming the line', () => {
    const folder = sealedFolder({ [LAYOUT.exchanges]: `${exchange}\ngarbage\n` });

    const data = loadRun(folder);

    expect(data.exchanges).toBeNull();
    expect(data.trouble).toEqual([
      { path: LAYOUT.exchanges, reason: expect.stringContaining('Line 2 ') },
    ]);
  });

  it('sets aside a file changed since the run was sealed', () => {
    const folder = sealedFolder({ [LAYOUT.exchanges]: `${exchange}\n` });
    writeFileSync(join(folder, LAYOUT.exchanges), 'changed\n');

    const data = loadRun(folder);

    expect(data.exchanges).toBeNull();
    expect(data.trouble).toEqual([
      { path: LAYOUT.exchanges, reason: 'changed since the run was sealed' },
    ]);
  });
});
