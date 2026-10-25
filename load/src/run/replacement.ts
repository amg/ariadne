/** How long a replacement takes to bring its users back, as real users return one by one after a blip. */
const RECONNECT_SECONDS = 60;

/** With less than this left of the run, a replacement has nothing to show for its start. */
const LEAST_WORTH_RELAUNCHING_SECONDS = 5;

/**
 * The plan of a generator that replaces a lost one with `secondsLeft` of
 * the run to go. It brings its users back over about a minute and holds
 * for what remains, so that it ends with the run. Near the end the whole
 * of what remains is spent bringing users back. Null when too little of
 * the run is left to be worth a start.
 */
export function replacementPlan(secondsLeft: number) {
  if (secondsLeft < LEAST_WORTH_RELAUNCHING_SECONDS) return null;
  const rampSeconds = Math.min(RECONNECT_SECONDS, secondsLeft);
  return { rampSeconds, holdSeconds: secondsLeft - rampSeconds };
}
