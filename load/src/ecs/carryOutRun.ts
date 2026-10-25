import { STOPPED_FOR_RUN_END } from '../records/index.ts';
import { Interrupted } from './interruption.ts';
import { messageOf } from './messageOf.ts';

/** How a run ended: its plan ran to the end, it was interrupted, or it failed. */
type RunOutcome = 'finished' | 'interrupted' | 'failed';

/** The exit status of a command whose run ended this way: 0 when it finished, 130 when it was interrupted, 1 when it failed. */
export function exitStatusOf(outcome: RunOutcome) {
  const statuses: Record<RunOutcome, number> = { finished: 0, interrupted: 130, failed: 1 };
  return statuses[outcome];
}

/** What a run keeps of itself: opened before its generators start, then sealed and rebuilt into a verdict once they have stopped. */
type RunRecord = {
  /** Writes the run's draft record, so that a run that never gets sealed is still visible. */
  open: () => Promise<void>;
  /** Collects what the run left and seals it. `endedAtOrNull` is null when the run's generators say when it ended. */
  seal: (end: { outcome: RunOutcome; endedAtOrNull: string | null }) => Promise<void>;
  /** Writes the verdict and report of the sealed run. */
  rebuild: () => Promise<void>;
};

type RunToCarryOut = {
  /** Null for a run that keeps no record, as when the population is seeded. */
  recordOrNull: RunRecord | null;
  /** Runs the generators to the end of the plan; rejects with what ended the run early. */
  runFleet: () => Promise<void>;
  /** Stops every generator still running; rejects when one could not be stopped. */
  stopEveryGenerator: (reason: string) => Promise<void>;
  say: (line: string) => void;
  /** The time; the clock unless a test says otherwise. */
  now?: () => Date;
};

/**
 * Carries out a run from its opening to its verdict. However the generators
 * end, the run stops every generator, seals the run with how it ended, and
 * rebuilds it. A step that cannot be done is said and the next one still
 * goes ahead, except that a run that could not be sealed is not rebuilt.
 * Resolves with how the run ended; it does not reject.
 */
export async function carryOutRun(run: RunToCarryOut) {
  const now = run.now ?? (() => new Date());
  try {
    await run.recordOrNull?.open();
  } catch (error) {
    run.say(`The run could not begin: ${messageOf(error)}`);
    return 'failed';
  }
  const outcome = await outcomeOfRunningFleet(run);
  await stopGeneratorsAtRunEnd(run, outcome);
  await sealAndRebuild(run, outcome, outcome === 'finished' ? null : now().toISOString());
  return outcome;
}

/** How the run ended, from what ended its generators; the reason is said. */
async function outcomeOfRunningFleet(run: RunToCarryOut) {
  try {
    await run.runFleet();
    return 'finished';
  } catch (error) {
    run.say(messageOf(error));
    return error instanceof Interrupted ? 'interrupted' : 'failed';
  }
}

async function stopGeneratorsAtRunEnd(run: RunToCarryOut, outcome: RunOutcome) {
  try {
    // The reason starts with the one the supervision gives, so that both kinds of stop read the same afterwards.
    await run.stopEveryGenerator(`${STOPPED_FOR_RUN_END}: the command ended (${outcome})`);
  } catch (error) {
    run.say(`${messageOf(error)}. The run is sealed as it stands.`);
  }
}

async function sealAndRebuild(
  run: RunToCarryOut,
  outcome: RunOutcome,
  endedAtOrNull: string | null,
) {
  const { recordOrNull } = run;
  if (recordOrNull === null) return;
  try {
    await recordOrNull.seal({ outcome, endedAtOrNull });
  } catch (error) {
    run.say(`The run is not sealed: ${messageOf(error)}`);
    return;
  }
  try {
    await recordOrNull.rebuild();
  } catch (error) {
    run.say(`The run is sealed but not rebuilt: ${messageOf(error)}`);
  }
}
