import { type HostSample, LAYOUT } from '../../records/index.ts';
import type { GuardLines } from '../../types/criteria.ts';
import { appendJsonLine } from '../runFolder.ts';
import type { UsersSoFar } from '../types.ts';
import { readHostSample } from './glances.ts';
import { judgeHost, judgeUsers } from './guard.ts';

type Breach = NonNullable<ReturnType<typeof judgeHost>>;

/** How many readings in a row may fail before the guard counts itself blind and stops the run. */
const MAX_BLIND_READINGS = 3;

type HouseWatch = {
  /** Takes no more readings, and resolves with the line that stopped the run, if one did. */
  stop: () => Promise<Breach | null>;
};

/**
 * Watches the house for as long as the run lasts. Every `intervalMs` it
 * reads the host and keeps each reading in the run's `folder`. When a line
 * is crossed, the watch calls `onBreach` once and takes no more readings.
 * The watch also stops the run when it can no longer see the host. Only a
 * failed read of the host counts as blind. When the watch cannot keep a
 * reading in the folder, or fails in any other way of its own, it calls
 * `onFailure` once with that error and takes no more readings.
 */
export function startHouseWatch(input: {
  folder: string;
  lines: GuardLines;
  glancesUrl: string;
  intervalMs: number;
  /** What the generators' users saw so far. */
  users: () => UsersSoFar;
  onBreach: (breach: Breach) => void;
  onFailure: (error: Error) => void;
}): HouseWatch {
  const ending = new AbortController();
  let breach: Breach | null = null;

  const loop = async (): Promise<void> => {
    let blindReadings = 0;
    while (!ending.signal.aborted && breach === null) {
      const reading = await readHost(input.glancesUrl);
      blindReadings = blindReadingsAfter(blindReadings, reading);
      const failure = failureToKeepOrNull(input.folder, reading);
      if (failure !== null) {
        input.onFailure(failure);
        return;
      }
      breach = judge(input, reading, blindReadings);
      if (breach !== null) input.onBreach(breach);
      else await waitOrEnd(input.intervalMs, ending.signal);
    }
  };
  const looping = loop().catch((error: unknown) => {
    input.onFailure(new Error(`The guard stopped watching: ${reasonOf(error)}`, { cause: error }));
  });

  return {
    async stop() {
      ending.abort();
      await looping;
      return breach;
    },
  };
}

type Reading = { kind: 'read'; sample: HostSample } | { kind: 'blind'; error: unknown };

async function readHost(glancesUrl: string): Promise<Reading> {
  try {
    return { kind: 'read', sample: await readHostSample(glancesUrl) };
  } catch (error) {
    return { kind: 'blind', error };
  }
}

/** How many readings in a row have failed, counting this one. */
function blindReadingsAfter(blindReadings: number, reading: Reading) {
  return reading.kind === 'blind' ? blindReadings + 1 : 0;
}

/** The error that kept the reading out of the run's folder; null when it was kept, or when there was no reading. */
function failureToKeepOrNull(folder: string, reading: Reading) {
  if (reading.kind === 'blind') return null;
  try {
    appendJsonLine(folder, LAYOUT.hostSamples, reading.sample);
    return null;
  } catch (error) {
    return new Error(`The guard could not keep a host reading: ${reasonOf(error)}`, {
      cause: error,
    });
  }
}

/** The line a reading crosses, or null when it crosses none. */
function judge(
  input: { glancesUrl: string; lines: GuardLines; users: () => UsersSoFar },
  reading: Reading,
  blindReadings: number,
): Breach | null {
  if (reading.kind === 'read') {
    return judgeHost(input.lines, reading.sample) ?? judgeUsers(input.lines, input.users());
  }
  return blindReadings >= MAX_BLIND_READINGS ? unreadable(input.glancesUrl, reading.error) : null;
}

function reasonOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function unreadable(glancesUrl: string, error: unknown): Breach {
  return {
    line: 'host-unreadable',
    observed: MAX_BLIND_READINGS,
    limit: MAX_BLIND_READINGS,
    message: `the host could not be read from ${glancesUrl} ${MAX_BLIND_READINGS} times in a row (${reasonOf(error)})`,
  };
}

function waitOrEnd(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
