import type { ManifestSlice, RunEvent, StateLine } from '../../records/index.ts';

type Launch = Extract<RunEvent, { kind: 'generator-launched' }>;

/**
 * The slice with each down window running until its users were back. The
 * archive ends a window when a replacement's plan has brought the users
 * back, but a user whose sign-in keeps failing is not back. A window that a
 * replacement ended runs on to the earliest state line in which that
 * replacement had every user it was given signed in. A window keeps its end
 * when no such line comes, so a slice that never came back is judged as it
 * was. It keeps it too when no replacement ended it, and every window does
 * when the run's events or the slice's state lines are unusable.
 */
export function downUntilUsersBack({
  slice,
  states,
  events,
}: {
  slice: ManifestSlice;
  states: readonly StateLine[] | null;
  events: readonly RunEvent[] | null;
}) {
  if (states === null || events === null) return slice;
  const down = slice.down.map((window) => {
    const replacement = events.reduce<Launch | null>(
      (latest, event) =>
        event.kind === 'generator-launched' &&
        event.generator === slice.generator &&
        event.at >= window.from &&
        event.at <= window.to &&
        (latest === null || event.attempt > latest.attempt)
          ? event
          : latest,
      null,
    );
    if (replacement === null) return window;
    const back = states.reduce<string | null>(
      (earliest, state) =>
        state.attempt === replacement.attempt &&
        state.usersSignedIn >= replacement.userCount &&
        (earliest === null || state.at < earliest)
          ? state.at
          : earliest,
      null,
    );
    if (back === null || back <= window.to) return window;
    return { ...window, to: back, reason: `${window.reason}, all signed in again at ${back}` };
  });
  return { ...slice, down };
}
