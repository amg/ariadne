import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reportInFile, sortGeneratorOutputFile } from './generatorOutput.ts';

/** Sorts what a generator printed through sinks that collect lines, as files do; the report is found apart. */
async function sorted(text: string) {
  const folder = mkdtempSync(join(tmpdir(), 'generator-output-'));
  const file = join(folder, 'out.log');
  writeFileSync(file, text);
  const taken: Record<'requests' | 'states' | 'rest', string[]> = {
    requests: [],
    states: [],
    rest: [],
  };
  const sink = (list: keyof typeof taken) => ({
    write: async (line: string) => void taken[list].push(line),
    end: async () => undefined,
  });
  await sortGeneratorOutputFile(file, {
    requests: sink('requests'),
    states: sink('states'),
    rest: sink('rest'),
  });
  return { ...taken, report: await reportInFile(file) };
}

describe('sortGeneratorOutputFile', () => {
  it('sorts each kind of line, keeping the order of the rest', async () => {
    expect(
      await sorted(
        [
          'starting',
          'REQUEST {"user":1}',
          'STATE {"at":"a"}',
          'an unknown line',
          'REQUEST {"user":2}',
          'a warning',
          'REPORT {"runId":"run-1"}',
          '',
        ].join('\n'),
      ),
    ).toEqual({
      requests: ['{"user":1}', '{"user":2}'],
      states: ['{"at":"a"}'],
      report: '{"runId":"run-1"}',
      rest: ['starting', 'an unknown line', 'a warning'],
    });
  });

  it('keeps only the record of a line that also carries metric fields', async () => {
    expect(
      await sorted(
        [
          '{"request":{"user":1,"kind":"chat"},"_aws":{"Timestamp":1},"ChatFirstByteMs":900}',
          '{"state":{"at":"a"},"_aws":{"Timestamp":2},"UsersSignedIn":3}',
          'REPORT {"runId":"run-1"}',
          '',
        ].join('\n'),
      ),
    ).toEqual({
      requests: ['{"user":1,"kind":"chat"}'],
      states: ['{"at":"a"}'],
      report: '{"runId":"run-1"}',
      rest: [],
    });
  });

  it('leaves a JSON line that is no record, or is cut short, with the rest', async () => {
    const result = await sorted(
      ['{"request":"not a record"}', '{"request":{"user":1', '{"level":30}', ''].join('\n'),
    );

    expect(result.requests).toEqual([]);
    expect(result.rest).toEqual([
      '{"request":"not a record"}',
      '{"request":{"user":1',
      '{"level":30}',
    ]);
  });

  it('has the last report of a generator that printed several, and none from one that printed none', async () => {
    expect((await sorted('REPORT {"runId":"early"}\nREPORT {"runId":"late"}\n')).report).toBe(
      '{"runId":"late"}',
    );
    expect((await sorted('REQUEST {"user":1}\n')).report).toBeNull();
  });

  it('leaves a half-written last line with the rest, not with the requests', async () => {
    const result = await sorted('REQUEST {"user":1}\nREQUEST {"user":2,"ki');

    expect(result.requests).toEqual(['{"user":1}']);
    expect(result.rest).toEqual(['REQUEST {"user":2,"ki']);
  });

  it('leaves a half-written report line out, finding no report', async () => {
    expect((await sorted('REPORT {"runId":"run-1"')).report).toBeNull();
  });

  it('is empty for no output', async () => {
    expect(await sorted('')).toEqual({ requests: [], states: [], report: null, rest: [] });
  });
});
