let failures = 0;

/** Counts a message or a subscription that the carrier could not get through to the other copies. */
export function countCarrierFailure() {
  failures += 1;
}

/** The failures counted since this was last called. */
export function takeCarrierFailures() {
  const counted = failures;
  failures = 0;
  return counted;
}
