import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const LINES = 3_000;

/** A program that prints far more than a pipe holds, then a last line, then exits as the generator does. */
const program = `
  const { outputWritten } = await import(${JSON.stringify(new URL('./outputWritten.ts', import.meta.url).href)});
  for (let line = 0; line < ${LINES}; line += 1) console.log('x'.repeat(1_000));
  console.log('REPORT');
  await outputWritten();
  process.exit(0);
`;

/** What the program printed, read by a reader that starts late. */
async function printedBySlowReader() {
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.setEncoding('utf8');
  child.stdout.pause();
  let printed = '';
  child.stdout.on('data', (chunk: string) => {
    printed += chunk;
  });
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.stdout.resume();
  await closed;
  return printed;
}

describe('outputWritten', () => {
  it('lets a generator whose output drains slowly deliver its last line before it exits', async () => {
    const printed = await printedBySlowReader();

    expect(printed.trimEnd().split('\n')).toHaveLength(LINES + 1);
    expect(printed.endsWith('REPORT\n')).toBe(true);
  });

  it('settles at once when there is nothing left to write', async () => {
    const { outputWritten } = await import('./outputWritten.ts');

    await expect(outputWritten([{ write: (_text, done) => done() }])).resolves.toBeUndefined();
  });
});
