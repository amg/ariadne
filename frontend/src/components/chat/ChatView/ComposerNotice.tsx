import type { UnansweredArrival } from './types';

const UNANSWERED_ARRIVAL_COPY: Record<UnansweredArrival, string> = {
  pending: 'This message is still being checked.',
  cleared: 'This message is checked and ready for a reply.',
  failed: 'This message could not be checked.',
};

/**
 * The calm line over the composer while an arrival owes its reply: the
 * message stays, and a retry waits on the same judgment again. It sits
 * where an error line sits, but never shouts.
 */
function UnansweredArrivalNotice({
  kind,
  onRetry,
}: {
  kind: UnansweredArrival;
  onRetry: () => void;
}) {
  return (
    <p className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
      {UNANSWERED_ARRIVAL_COPY[kind]}
      <button
        type="button"
        onClick={onRetry}
        className="underline underline-offset-2 transition-colors hover:text-foreground"
      >
        retry
      </button>
    </p>
  );
}

/** The line over the composer: the unanswered arrival's notice, else the error, else nothing. */
export function ComposerNotice({
  unansweredArrival,
  errorMessage,
  onRetry,
}: {
  unansweredArrival: UnansweredArrival | null | undefined;
  errorMessage: string | null | undefined;
  onRetry: () => void;
}) {
  if (unansweredArrival)
    return <UnansweredArrivalNotice kind={unansweredArrival} onRetry={onRetry} />;
  if (errorMessage) return <p className="mb-2 text-sm text-red-400">{errorMessage}</p>;
  return null;
}
