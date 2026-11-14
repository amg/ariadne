/** How long a replacement takes to bring its users back, as real users return one by one after a blip. */
const RECONNECT_SECONDS = 60;

/** With less than this left of the run, a replacement has nothing to show for its start. */
const LEAST_WORTH_RELAUNCHING_SECONDS = 5;

/**
 * The plan of a generator that replaces a lost one with `secondsLeft` of
 * the run to go, for a slice of `userCount` users in a run whose users
 * leave over its last `fallSeconds`. It brings its users back over about a
 * minute, holds, and lets them go over what is left of the fall, so that it
 * ends with the run. Near the end the whole of what remains is spent
 * bringing users back. A replacement whose fall begins after the run's has
 * brings back only the users who are still there when its fall begins: the
 * last to arrive leave first, so those are the slice's first users. Null
 * when too little of the run is left to be worth a start, or when none of
 * the users would still be there once they were back.
 */
export function replacementPlan(input: {
  secondsLeft: number;
  fallSeconds: number;
  userCount: number;
}) {
  const { secondsLeft, fallSeconds, userCount } = input;
  if (secondsLeft < LEAST_WORTH_RELAUNCHING_SECONDS) return null;
  const rampSeconds = Math.min(RECONNECT_SECONDS, secondsLeft);
  const fallLeftSeconds = Math.min(fallSeconds, secondsLeft - rampSeconds);
  const lateInFall = fallLeftSeconds < fallSeconds;
  const usersLeft = lateInFall
    ? Math.min(userCount, Math.ceil((userCount * fallLeftSeconds) / fallSeconds))
    : userCount;
  if (lateInFall && usersLeft === 0) return null;
  return {
    rampSeconds,
    holdSeconds: secondsLeft - rampSeconds - fallLeftSeconds,
    fallSeconds: fallLeftSeconds,
    userCount: usersLeft,
  };
}
