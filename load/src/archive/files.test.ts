import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeFile, listRunFiles, sha256Of, sha256OfFile, writeOnce } from './files.ts';

const folderOf = () => mkdtempSync(join(tmpdir(), 'files-'));

describe('describeFile', () => {
  it('gives a file’s size and checksum', () => {
    const folder = folderOf();
    writeFileSync(join(folder, 'a.txt'), 'abc');

    expect(describeFile(folder, 'a.txt')).toEqual({
      path: 'a.txt',
      size: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
  });

  it('is null for a file that is not there', () => {
    expect(describeFile(folderOf(), 'nope')).toBeNull();
  });
});

describe('listRunFiles', () => {
  it('lists every raw file by path, leaving out the manifest, the unsorted output and what a rebuild derived', () => {
    const folder = folderOf();
    mkdirSync(join(folder, 'logs'));
    mkdirSync(join(folder, '.sources'));
    mkdirSync(join(folder, 'derived'));
    writeFileSync(join(folder, 'manifest.json'), '{}');
    writeFileSync(join(folder, 'logs', 'b.log'), '');
    writeFileSync(join(folder, 'a.jsonl'), '');
    writeFileSync(join(folder, '.sources', 'x.out'), '');
    writeFileSync(join(folder, 'derived', 'verdict.md'), '');

    expect(listRunFiles(folder)).toEqual(['a.jsonl', 'logs/b.log']);
  });

  it('lists nothing for a folder that does not exist', () => {
    expect(listRunFiles(join(folderOf(), 'missing'))).toEqual([]);
  });
});

describe('writeOnce', () => {
  it('writes a file that is not there, making its folders', () => {
    const folder = folderOf();

    expect(writeOnce(folder, 'deep/er/a.txt', 'abc')).toBe(true);
    expect(readFileSync(join(folder, 'deep/er/a.txt'), 'utf8')).toBe('abc');
  });

  it('leaves a file alone that already holds what would be written', () => {
    const folder = folderOf();
    writeOnce(folder, 'a.txt', 'abc');
    const before = statSync(join(folder, 'a.txt')).mtimeMs;

    expect(writeOnce(folder, 'a.txt', 'abc')).toBe(false);
    expect(statSync(join(folder, 'a.txt')).mtimeMs).toBe(before);
  });

  it('writes again when the content differs', () => {
    const folder = folderOf();
    writeOnce(folder, 'a.txt', 'abc');

    expect(writeOnce(folder, 'a.txt', 'abd')).toBe(true);
    expect(readFileSync(join(folder, 'a.txt'), 'utf8')).toBe('abd');
  });
});

describe('sha256Of', () => {
  it('is the same for the same content, text or bytes', () => {
    expect(sha256Of('abc')).toBe(sha256Of(Buffer.from('abc')));
  });
});

describe('sha256OfFile', () => {
  it('gives the same checksum as the whole content gives, for a file of several pieces', () => {
    const folder = folderOf();
    const content = Buffer.alloc(3 * 1_048_576 + 12_345, 'abcdefghij');
    writeFileSync(join(folder, 'big.bin'), content);

    expect(sha256OfFile(join(folder, 'big.bin'))).toBe(sha256Of(content));
  });

  it('gives the checksum of nothing for an empty file', () => {
    const folder = folderOf();
    writeFileSync(join(folder, 'empty'), '');

    expect(sha256OfFile(join(folder, 'empty'))).toBe(sha256Of(''));
  });
});
