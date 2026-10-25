/** What ended a run before its generators did: the operator, or the system the command ran under. */
export class Interrupted extends Error {}

/** Where signals come from: the process, or a stand-in for it. */
type SignalSource = { on: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => unknown };

/**
 * A signal that aborts when the operator presses Ctrl-C or the system asks
 * the command to end. Its reason is the first signal received. Every signal
 * after the first is only passed to `onRepeat`, so that a second Ctrl-C
 * cannot kill the command while it stops the generators and seals the run.
 */
export function interruptionOf(
  source: SignalSource,
  onRepeat: (signal: 'SIGINT' | 'SIGTERM') => void,
) {
  const interruption = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    source.on(signal, () => {
      if (interruption.signal.aborted) return onRepeat(signal);
      interruption.abort(new Interrupted(`The load command received ${signal}`));
    });
  }
  return interruption.signal;
}
