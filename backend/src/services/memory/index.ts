/**
 * User memory — public seam. `captureClosedSegments` is the segment-close
 * hook that turns closed segments into stored Facts, `captureUnreadTurns`
 * the on-demand pass that also reads the segment still open, and
 * `capturesSettled` waits out the captures in flight. `seedThread` freezes a fresh Thread's
 * Seed (`currentSeed` renders one for a caller that stores it itself), and
 * `assembledSystemPrompt` adds it to every Exchange. `editFactContent`
 * replaces a Fact with a user-edited sentence.
 *
 * `captureFacts`, `segmentTurns`, `factsNamedIn`, `namesInFact` and
 * `renderedSeedOrNull` are exported for their tests only; nothing else in
 * the app should reach them.
 */
export { captureFacts } from './captureFacts';
export {
  captureClosedSegments,
  captureUnreadTurns,
  capturesSettled,
  segmentTurns,
} from './captureClosedSegments';
export { assembledSystemPrompt, currentSeed, renderedSeedOrNull, seedThread } from './seed';
export { editFactContent } from './editFact';
export { factsNamedIn, namesInFact } from './factsNamedIn';
