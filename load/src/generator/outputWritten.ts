/** Where a generator prints to. */
type Output = { write(text: string, done: () => void): unknown };

/**
 * Settles once everything written to `outputs` so far has reached the
 * other end. A pipe that its reader drains slowly holds written text in
 * the process, and a process that exits first loses it.
 */
export async function outputWritten(outputs: readonly Output[] = [process.stdout, process.stderr]) {
  await Promise.all(
    outputs.map((output) => new Promise<void>((resolve) => output.write('', resolve))),
  );
}
