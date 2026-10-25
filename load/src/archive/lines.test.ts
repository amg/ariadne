import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lineSink, linesOfFile } from './lines.ts';

const folderOf = () => mkdtempSync(join(tmpdir(), 'lines-'));

async function allLines(file: string) {
  const found = [];
  for await (const line of linesOfFile(file)) found.push(line);
  return found;
}

describe('linesOfFile', () => {
  it('gives each line, and marks the last complete only when a newline ended it', async () => {
    const file = join(folderOf(), 'a.log');
    writeFileSync(file, 'one\ntwo\nthr');

    expect(await allLines(file)).toEqual([
      { text: 'one', complete: true },
      { text: 'two', complete: true },
      { text: 'thr', complete: false },
    ]);
  });

  it('gives no unfinished line for a file that ends in a newline, nor for an empty file', async () => {
    const folder = folderOf();
    writeFileSync(join(folder, 'a.log'), 'one\n');
    writeFileSync(join(folder, 'b.log'), '');

    expect(await allLines(join(folder, 'a.log'))).toEqual([{ text: 'one', complete: true }]);
    expect(await allLines(join(folder, 'b.log'))).toEqual([]);
  });

  it('keeps blank lines', async () => {
    const file = join(folderOf(), 'a.log');
    writeFileSync(file, 'one\n\ntwo\n');

    expect((await allLines(file)).map((line) => line.text)).toEqual(['one', '', 'two']);
  });

  it('reads a line that is longer than a piece of the file, and one cut in the middle of a multi-byte character', async () => {
    const file = join(folderOf(), 'a.log');
    const long = 'é'.repeat(200_000);
    writeFileSync(file, `${long}\nnaïve ✓\n`);

    expect((await allLines(file)).map((line) => line.text)).toEqual([long, 'naïve ✓']);
  });

  it('fails for a file that is not there', async () => {
    await expect(allLines(join(folderOf(), 'nope'))).rejects.toThrow();
  });
});

describe('lineSink', () => {
  it('writes each line and its newline, and makes the file empty first', async () => {
    const file = join(folderOf(), 'out.log');
    writeFileSync(file, 'old');
    const sink = lineSink(file);

    await sink.write('one');
    await sink.write('two');
    await sink.end();

    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
  });

  it('leaves an empty file when nothing was written', async () => {
    const file = join(folderOf(), 'out.log');
    await lineSink(file).end();

    expect(readFileSync(file, 'utf8')).toBe('');
  });

  it('holds every line of a write that outpaces the disk, in order, waiting for it to drain', async () => {
    const file = join(folderOf(), 'out.log');
    const sink = lineSink(file);
    const line = 'x'.repeat(10_000);

    for (let number = 0; number < 2_000; number += 1) await sink.write(`${number} ${line}`);
    await sink.end();

    const written = readFileSync(file, 'utf8').split('\n');
    expect(written).toHaveLength(2_001);
    expect(written[1_999]).toBe(`1999 ${line}`);
  });

  it('fails a write into a folder that is not there', async () => {
    const sink = lineSink(join(folderOf(), 'missing', 'out.log'));

    await expect(sink.end()).rejects.toThrow();
  });
});
