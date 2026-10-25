/**
 * User memory — public seam. `captureSegment` turns one settled segment's
 * unread Turns into stored Facts, `captureUnreadTurns` is the on-demand
 * pass over everything in a thread not yet read, the open segment
 * included. `seedThread` freezes a fresh Thread's Seed (`currentSeed`
 * renders one for a caller that stores it itself, `EMPTY_SEED` is one with
 * nothing to say), and `assembledSystemPrompt` adds it to every Exchange.
 * `MemoryFeature` is whether the deployment runs Memory at all, handed
 * down by whoever decided it. `editFactContent` replaces a Fact with a
 * user-edited sentence.
 *
 * `readFacts`, `segmentTurns`, `factsNamedIn`, `namesInFact` and
 * `renderedSeedOrNull` are exported for their tests only; nothing else in
 * the app should reach them.
 */
export { readFacts } from './readFacts';
export {
  captureSegment,
  captureUnreadTurns,
  segmentTurns,
} from './captureSegments';
export {
  EMPTY_SEED,
  assembledSystemPrompt,
  currentSeed,
  renderedSeedOrNull,
  seedThread,
} from './seed';

export { editFactContent } from './editFact';
export { factsNamedIn, namesInFact } from './factsNamedIn';
